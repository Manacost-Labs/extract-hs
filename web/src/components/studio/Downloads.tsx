'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/valyro-ui/basic/Button';
import { Spinner } from '@/components/valyro-ui/basic/Spinner';
import { Checkbox } from '@/components/valyro-ui/forms/Checkbox';
import { Dialog } from '@/components/valyro-ui/feedback/Dialog';
import { confirm } from '@/components/valyro-ui/feedback/ConfirmDialog';
import { SegmentedControl } from '@/components/valyro-ui/navigation/SegmentedControl';
import { DownloadIcon } from '@/components/valyro-ui/icons';
import { api, formatBytes } from '@/lib/api';
import type { DownloadAction } from '@/lib/download';
import { ExportOptions, runExport, useExportOpts } from './ExportOptions';

const fmt = (n: number) => n.toLocaleString('ru-RU');

/** Скачивание узла/запроса: всё раскладывается «Категория/группа/имя», уже скачанное пропускается (докачка). */
export function useDownload() {
  const { opts } = useExportOpts();
  return useCallback(
    async (a: DownloadAction, skipConfirm = false) => {
      const n = a.count ?? 0;
      if (!skipConfirm && n > 300) {
        const ok = await confirm({
          title: a.kind === 'raw' ? `Скопировать ${fmt(n)} бандлов?` : `Скачать ${fmt(n)} файлов?`,
          description: a.kind === 'raw'
            ? `${a.label}: исходные .unity3d как есть, в папку «Бандлы».`
            : `${a.label}. Файлы разложатся по папкам «Категория/группа»; уже скачанные будут пропущены, так что прерванную загрузку можно продолжить.`,
          confirmLabel: 'Скачать',
        });
        if (!ok) return;
      }
      const label = `Скачиваю ${a.label}…`;
      const tree = { opts, layout: 'tree' as const, skipExisting: true };
      if (a.kind === 'query') return runExport(label, () => api.export({ ...tree, query: a.query }));
      if (a.kind === 'bundle') return runExport(label, () => api.export({ ...tree, bundleAll: a.bundles }));
      if (a.kind === 'items') return runExport(label, () => api.export({ ...tree, items: a.items }));
      return runExport(label, () => api.exportRaw({ bundles: a.bundles, group: a.group, all: a.all, skipExisting: true }));
    },
    [opts],
  );
}

const CATEGORIES = [
  { key: 'textures', label: 'Текстуры', types: ['Texture2D'], hint: 'PNG/WebP' },
  { key: 'sprites', label: 'Спрайты интерфейса', types: ['Sprite'], hint: 'PNG/WebP' },
  { key: 'audio', label: 'Звуки и музыка', types: ['AudioClip'], hint: 'WAV' },
  { key: 'video', label: 'Видео', types: ['VideoClip'], hint: 'MP4' },
  { key: 'fonts', label: 'Шрифты', types: ['Font'], hint: 'TTF/OTF' },
  { key: 'text', label: 'Тексты', types: ['TextAsset'], hint: 'как есть' },
  { key: 'meshes', label: '3D-модели', types: ['Mesh'], hint: 'OBJ' },
  { key: 'animations', label: 'Анимации', types: ['AnimationClip', 'AnimatorController', 'AnimatorOverrideController'], hint: 'JSON' },
  { key: 'materials', label: 'Материалы', types: ['Material'], hint: 'JSON' },
  { key: 'shaders', label: 'Шейдеры', types: ['Shader'], hint: 'текст' },
  { key: 'mono', label: 'Скрипты и данные', types: ['MonoBehaviour'], hint: 'JSON' },
];

const ALL_TYPES = CATEGORIES.flatMap((c) => c.types);

/** «Скачать всё»: выбор категорий и языка, исходные бандлы. */
export function DownloadAllDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (b: boolean) => void }) {
  const download = useDownload();
  const [lang, setLang] = useState('');
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [bundlesSize, setBundlesSize] = useState(0);
  const [picked, setPicked] = useState<Set<string>>(new Set(['textures', 'sprites', 'audio', 'video', 'fonts', 'text']));
  const [raw, setRaw] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCounts(null);
    api.count({ types: ALL_TYPES.join(','), lang }).then(setCounts);
    api.groups().then((g) => setBundlesSize(g.reduce((s, x) => s + x.size, 0)));
  }, [open, lang]);

  const catCount = useCallback((c: (typeof CATEGORIES)[number]) => c.types.reduce((s, t) => s + (counts?.[t] ?? 0), 0), [counts]);
  const total = useMemo(() => CATEGORIES.filter((c) => picked.has(c.key)).reduce((s, c) => s + catCount(c), 0), [picked, catCount]);

  const start = () => {
    const types = CATEGORIES.filter((c) => picked.has(c.key)).flatMap((c) => c.types);
    onOpenChange(false);
    if (types.length) {
      void download({ kind: 'query', query: { types: types.join(','), lang }, label: 'всё выбранное', count: total }, true);
    }
    if (raw) void download({ kind: 'raw', all: true, label: 'все бандлы', count: 0 }, true);
  };

  const toggle = (key: string, on: boolean) =>
    setPicked((s) => {
      const n = new Set(s);
      if (on) n.add(key);
      else n.delete(key);
      return n;
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="md" title="Скачать всё"
      description="Файлы раскладываются по папкам «Категория/группа». Уже скачанное пропускается — можно остановить и продолжить позже."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Отмена</Button>
          <Button variant="primary" leftIcon={<DownloadIcon />} disabled={!counts || (!total && !raw)} onClick={start}>
            Скачать {total ? `${fmt(total)} файлов` : ''}{raw ? (total ? ' + бандлы' : 'бандлы') : ''}
          </Button>
        </>
      }>
      <div className="download-all">
        <div className="field-row">
          <span>Язык</span>
          <SegmentedControl aria-label="Язык" size="sm" value={lang} onValueChange={setLang}
            options={[{ value: '', label: 'Все' }, { value: 'ruru', label: 'Русский' }, { value: 'enus', label: 'English' }]} />
        </div>
        <div className="cat-list">
          {CATEGORIES.map((c) => (
            <div key={c.key} className="cat-row">
              <Checkbox label={c.label} checked={picked.has(c.key)} onCheckedChange={(b) => toggle(c.key, b)} />
              <span className="muted small">{c.hint}</span>
              <span className="mono small push-right">{counts ? fmt(catCount(c)) : <Spinner size={10} label={null} />}</span>
            </div>
          ))}
          <div className="cat-row">
            <Checkbox label="Исходные файлы бандлов (.unity3d)" checked={raw} onCheckedChange={setRaw} />
            <span className="muted small">как в папке игры</span>
            <span className="mono small push-right">{bundlesSize ? formatBytes(bundlesSize) : ''}</span>
          </div>
        </div>
        <ExportOptions />
      </div>
    </Dialog>
  );
}
