'use client';

import { Button } from '@/components/valyro-ui/basic/Button';
import { Separator } from '@/components/valyro-ui/basic/Separator';
import { DownloadIcon } from '@/components/valyro-ui/icons';
import { api, formatBytes, type AssetInfo, type AssetRef } from '@/lib/api';
import { ExportOptions, runExport, useExportOpts } from './ExportOptions';
import { TypeIcon } from './icons';

const PROP_LABELS: Record<string, string> = {
  width: 'Ширина', height: 'Высота', format: 'Формат', mips: 'Мип-уровни', length: 'Длительность, с',
  frequency: 'Частота, Гц', channels: 'Каналы', frames: 'Кадров', fps: 'FPS', source: 'Исходник',
  vertices: 'Вершин', submeshes: 'Сабмешей', sampleRate: 'Частота кадров', loop: 'Зациклено',
  bindings: 'Анимируемых свойств', script: 'Скрипт', bytes: 'Размер данных', error: 'Ошибка', alpha: 'Альфа-канал',
};

const ALPHA_LABELS: Record<string, string> = { none: 'нет', transparent: 'прозрачность', mask: 'маска (уберётся при экспорте)' };

type Ref = AssetRef & { slot?: string; ext?: string };

function RefButton({ r, onOpen }: { r: Ref; onOpen: (r: AssetRef) => void }) {
  if (!r.b) return <span className="muted small">{r.ext ?? '—'}</span>;
  return (
    <button className="ref-btn" onClick={() => onOpen(r)} title={r.b}>
      {r.t && <TypeIcon type={r.t} size={12} />}
      <span className="ellipsis">{r.slot ? `${r.slot}: ` : ''}{r.n || r.t || `#${r.p}`}</span>
    </button>
  );
}

export function Inspector({ info, onOpen }: { info: AssetInfo | null; onOpen: (r: AssetRef) => void }) {
  const { opts } = useExportOpts();
  if (!info) return <div className="inspector"><div className="panel-title">Свойства</div><div className="muted pad">Выберите ассет</div></div>;

  const scalars = Object.entries(info.props)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
    .map(([k, v]) => [k, k === 'alpha' ? ALPHA_LABELS[String(v)] ?? v : v] as const);
  const refs: { label: string; items: Ref[] }[] = [];
  if (info.props.texture) refs.push({ label: 'Текстура', items: [info.props.texture as Ref] });
  if (info.props.shader) refs.push({ label: 'Шейдер', items: [info.props.shader as Ref] });
  if (Array.isArray(info.props.textures) && info.props.textures.length) refs.push({ label: 'Текстуры', items: info.props.textures as Ref[] });

  const isImage = info.kind === 'image';
  const ext = info.type === 'Mesh' ? 'OBJ' : info.type === 'Shader' ? 'SHADER'
    : { image: (opts.format ?? 'png').toUpperCase(), audio: 'WAV', video: 'MP4', font: 'TTF', text: 'TXT', data: 'JSON' }[info.kind];

  return (
    <div className="inspector">
      <div className="panel-title">Свойства</div>
      <div className="inspector-body">
        <dl className="props">
          <dt>Имя</dt><dd className="ellipsis" title={info.name}>{info.name || '—'}</dd>
          <dt>Тип</dt><dd>{info.type}</dd>
          <dt>Path ID</dt><dd className="mono small">{info.p}</dd>
          <dt>Бандл</dt><dd className="mono small break">{info.b}</dd>
          <dt>Объект</dt><dd>{formatBytes(info.size)}</dd>
          {scalars.map(([k, v]) => (
            <div key={k} className="contents">
              <dt>{PROP_LABELS[k] ?? k}</dt><dd className={k === 'error' ? 'danger' : ''}>{String(v)}</dd>
            </div>
          ))}
        </dl>
        {refs.map((g) => (
          <div key={g.label} className="refs">
            <div className="section-label">{g.label}</div>
            {g.items.map((r, i) => <RefButton key={i} r={r} onOpen={onOpen} />)}
          </div>
        ))}
        <Separator />
        <div className="section-label">Экспорт</div>
        {isImage && <ExportOptions />}
        <Button variant="primary" size="sm" fullWidth leftIcon={<DownloadIcon />}
          onClick={() => runExport('Экспорт…', () => api.export({ items: [info], opts: isImage ? opts : {} }))}>
          Сохранить {ext}
        </Button>
        {info.kind === 'data' && info.type.startsWith('Anim') && (
          <p className="muted small">Анимации Unity — это кривые ключевых кадров для 3D-объектов; они сохраняются как JSON. Для спрайтовых эффектов используйте «Анимация (флипбук)» у текстуры.</p>
        )}
      </div>
    </div>
  );
}
