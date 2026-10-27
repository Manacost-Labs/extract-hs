'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/valyro-ui/basic/Button';
import { Select } from '@/components/valyro-ui/forms/Select';
import { Slider } from '@/components/valyro-ui/forms/Slider';
import { DownloadIcon, GridIcon, PauseIcon, PlayIcon } from '@/components/valyro-ui/icons';
import { api, previewUrl, type AssetInfo } from '@/lib/api';
import { runExport } from './ExportOptions';

/** Сетка кадров из имени (…_4x4, …8x8…) или квадратная по умолчанию. */
function guessGrid(name: string, w: number, h: number): [number, number] {
  const m = name.match(/(\d{1,2})x(\d{1,2})/i);
  if (m) return [Number(m[1]), Number(m[2])];
  if (w && h && w === h) return [4, 4];
  if (w && h && w > h) return [Math.round(w / h), 1];
  return [1, Math.max(1, Math.round(h / Math.max(1, w)))];
}

/** Покадровая анимация из спрайт-листа (flipbook): превью и экспорт в WebP/GIF/APNG/кадры. */
export function Flipbook({ info }: { info: AssetInfo }) {
  const w = Number(info.props.width) || 0;
  const h = Number(info.props.height) || 0;
  const [g0, g1] = guessGrid(info.name, w, h);
  const [cols, setCols] = useState(g0);
  const [rows, setRows] = useState(g1);
  const [count, setCount] = useState(g0 * g1);
  const [fps, setFps] = useState(24);
  const [playing, setPlaying] = useState(true);
  const [format, setFormat] = useState('webp');
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const frame = useRef(0);

  const [guessing, setGuessing] = useState(false);

  const autoGrid = useCallback(async () => {
    setGuessing(true);
    try {
      const g = await api.grid(info);
      setCols(g.cols);
      setRows(g.rows);
      setCount(g.cols * g.rows);
      frame.current = 0;
    } finally {
      setGuessing(false);
    }
  }, [info]);

  useEffect(() => {
    const el = new Image();
    el.onload = () => setImg(el);
    el.src = previewUrl(info);
    // сетка из имени надёжнее; без неё — по содержимому картинки
    if (!/\d{1,2}x\d{1,2}/i.test(info.name)) void autoGrid();
  }, [info, autoGrid]);

  useEffect(() => setCount((c) => Math.min(Math.max(c, 1), cols * rows)), [cols, rows]);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !img) return;
    const fw = Math.floor(img.naturalWidth / cols);
    const fh = Math.floor(img.naturalHeight / rows);
    c.width = fw;
    c.height = fh;
    const ctx = c.getContext('2d')!;
    const draw = () => {
      const i = frame.current % count;
      ctx.clearRect(0, 0, fw, fh);
      ctx.drawImage(img, (i % cols) * fw, Math.floor(i / cols) * fh, fw, fh, 0, 0, fw, fh);
    };
    draw();
    if (!playing) return;
    const t = setInterval(() => {
      frame.current = (frame.current + 1) % count;
      draw();
    }, 1000 / fps);
    return () => clearInterval(t);
  }, [img, cols, rows, count, fps, playing]);

  const save = () =>
    runExport('Собираю анимацию…', () =>
      api.flipbook({ b: info.b, p: info.p, cols, rows, count, fps, format }),
    );

  return (
    <div className="flipbook">
      <div className="flip-stage bg-checker">
        <canvas ref={canvas} />
      </div>
      <div className="flip-controls">
        <Button size="sm" variant="secondary" leftIcon={<GridIcon />} loading={guessing} onClick={autoGrid}>
          Подобрать сетку автоматически
        </Button>
        <div className="field-row"><span>Колонки</span>
          <Slider aria-label="Колонки" min={1} max={16} value={cols} onValueChange={(v) => setCols(v as number)} tooltip />
          <span className="mono">{cols}</span></div>
        <div className="field-row"><span>Строки</span>
          <Slider aria-label="Строки" min={1} max={16} value={rows} onValueChange={(v) => setRows(v as number)} tooltip />
          <span className="mono">{rows}</span></div>
        <div className="field-row"><span>Кадров</span>
          <Slider aria-label="Кадров" min={1} max={Math.max(1, cols * rows)} value={count} onValueChange={(v) => setCount(v as number)} tooltip />
          <span className="mono">{count}</span></div>
        <div className="field-row"><span>FPS</span>
          <Slider aria-label="Кадров в секунду" min={1} max={60} value={fps} onValueChange={(v) => setFps(v as number)} tooltip />
          <span className="mono">{fps}</span></div>
        <div className="field-row">
          <span>Формат</span>
          <Select aria-label="Формат анимации" size="sm" value={format} onValueChange={setFormat}
            options={[
              { value: 'webp', label: 'WebP без потерь' },
              { value: 'apng', label: 'APNG без потерь' },
              { value: 'frames', label: 'Кадры PNG (папка)' },
              { value: 'gif', label: 'GIF (256 цветов)' },
            ]} />
        </div>
        <div className="row-gap">
          <Button size="sm" variant="secondary" leftIcon={playing ? <PauseIcon /> : <PlayIcon />} onClick={() => setPlaying(!playing)}>
            {playing ? 'Пауза' : 'Играть'}
          </Button>
          <Button size="sm" variant="primary" leftIcon={<DownloadIcon />} onClick={save}>Сохранить анимацию</Button>
        </div>
        <p className="muted small">Спрайт-листы эффектов (дым, огонь, искры) лежат в текстурах с сеткой кадров. Подберите колонки и строки — превью сразу обновится.</p>
      </div>
    </div>
  );
}
