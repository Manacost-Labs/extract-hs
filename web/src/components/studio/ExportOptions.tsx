'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { SegmentedControl } from '@/components/valyro-ui/navigation/SegmentedControl';
import { toast } from '@/components/valyro-ui/feedback/toast-store';
import { api, type AlphaMode, type ExportJob, type ExportResult, type ImageOpts } from '@/lib/api';

export const DEFAULT_OPTS: ImageOpts = { format: 'png', alpha: 'keep' };

const STORAGE_KEY = 'hs-export-opts-v2';

type Ctx = { opts: ImageOpts; setOpts: (v: ImageOpts) => void };
const ExportOptsContext = createContext<Ctx>({ opts: DEFAULT_OPTS, setOpts: () => {} });

/** Только допустимые поля: экспорт всегда отдаёт исходные пиксели. */
const sanitize = (v: Partial<ImageOpts>): ImageOpts => ({
  format: v.format === 'webp' ? 'webp' : 'png',
  alpha: v.alpha === 'auto' ? 'auto' : 'keep',
});

/** Одни настройки экспорта на всё приложение; запоминаются между запусками. */
export function ExportOptsProvider({ children }: { children: ReactNode }) {
  const [opts, setOptsState] = useState<ImageOpts>(DEFAULT_OPTS);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setOptsState(sanitize(JSON.parse(saved)));
    } catch {
      /* без сохранённых настроек */
    }
  }, []);
  const setOpts = (v: ImageOpts) => {
    const clean = sanitize(v);
    setOptsState(clean);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
    } catch {
      /* хранилище недоступно */
    }
  };
  return <ExportOptsContext.Provider value={{ opts, setOpts }}>{children}</ExportOptsContext.Provider>;
}

export const useExportOpts = () => useContext(ExportOptsContext);

export function ExportOptions() {
  const { opts, setOpts } = useExportOpts();
  return (
    <div className="export-opts">
      <div className="field-row">
        <span>Формат</span>
        <SegmentedControl aria-label="Формат" size="sm" value={opts.format ?? 'png'}
          onValueChange={(v) => setOpts({ ...opts, format: v as ImageOpts['format'] })}
          options={[{ value: 'png', label: 'PNG' }, { value: 'webp', label: 'WebP' }]} />
      </div>
      <div className="field-row">
        <span>Альфа</span>
        <SegmentedControl aria-label="Альфа-канал" size="sm" value={opts.alpha ?? 'keep'}
          onValueChange={(v) => setOpts({ ...opts, alpha: v as AlphaMode })}
          options={[{ value: 'keep', label: 'Исходник' }, { value: 'auto', label: 'Без маски' }]} />
      </div>
      <p className="muted small">Пиксели сохраняются как в игре, без масштабирования и сжатия с потерями.
        «Без маски» убирает альфу только там, где она служит маской эффектов (арт карт).</p>
    </div>
  );
}

const plural = (n: number) => n.toLocaleString('ru-RU');

function finish(id: string | number, r: ExportResult | ExportJob) {
  const job = 'count' in r ? r : null;
  const count = job ? job.count : r.files.length;
  const single = count === 1 && r.files.length === 1;
  const open = { label: single ? 'Показать' : 'Открыть папку', onClick: () => void api.reveal(single ? r.files[0] : r.dir) };
  const skipped = job?.skipped ? `, уже были: ${plural(job.skipped)}` : '';
  const errors = job ? job.errorCount : r.errors.length;
  const description = single ? r.files[0] : `${plural(count)} файлов${skipped} → ${r.dir}`;
  if (job?.state === 'cancelled') {
    toast.info('Экспорт остановлен', { id, description, duration: 8000, action: open });
  } else if (!count && errors) {
    toast.error('Не удалось экспортировать', { id, description: r.errors.slice(0, 3).join('\n'), duration: 10000 });
  } else if (errors) {
    toast.warning(`Сохранено ${plural(count)}, ошибок: ${plural(errors)}`, {
      id, description: `${description}\n${r.errors.slice(0, 2).join('\n')}`, duration: 10000, action: open,
    });
  } else {
    toast.success(count ? 'Сохранено' : 'Всё уже скачано', { id, description, duration: 8000, action: open });
  }
}

/** Экспорт с тостом: прогресс фонового задания, отмена и «Показать в папке» по готовности. */
export async function runExport(label: string, job: () => Promise<ExportJob | ExportResult>) {
  const id = toast.loading(label);
  try {
    const first = await job();
    let r: ExportResult | ExportJob = first;
    if ('id' in first) {
      let j: ExportJob = first;
      const cancel = { label: 'Отменить', onClick: () => void api.jobCancel(first.id) };
      while (j.state === 'running') {
        await new Promise((res) => setTimeout(res, 500));
        j = await api.job(j.id);
        if (j.total > 1) {
          const skipped = j.skipped ? ` · пропущено ${plural(j.skipped)}` : '';
          toast.loading(`${label} ${plural(j.done)} из ${plural(j.total)}${skipped}`, { id, action: cancel });
        }
      }
      r = j;
    }
    finish(id, r);
    return r;
  } catch (e) {
    toast.error('Не удалось экспортировать', { id, description: String((e as Error).message ?? e) });
    return null;
  }
}
