'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { Button } from '@/components/valyro-ui/basic/Button';
import { Spinner } from '@/components/valyro-ui/basic/Spinner';
import { Tooltip } from '@/components/valyro-ui/basic/Tooltip';
import { SegmentedControl } from '@/components/valyro-ui/navigation/SegmentedControl';
import { DownloadIcon, LayersIcon, MaximizeIcon, TargetIcon, XIcon } from '@/components/valyro-ui/icons';
import { api, previewUrl, type AssetInfo, type ExportItem } from '@/lib/api';
import { runExport, useExportOpts } from './ExportOptions';

type Channel = 'rgba' | 'rgb' | 'alpha';
type Bg = 'checker' | 'dark' | 'light';
type Tool = 'pan' | 'select';
type Box = [number, number, number, number];
type View = { s: number; x: number; y: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Просмотр картинки: зум колесом, перетаскивание, каналы, пипетка, элементы атласа и выделение области. */
export function ImageViewer({ info }: { info: AssetInfo }) {
  const { opts } = useExportOpts();
  const [channel, setChannel] = useState<Channel>(info.props.alpha === 'mask' ? 'rgb' : 'rgba');
  const [bg, setBg] = useState<Bg>('checker');
  const [tool, setTool] = useState<Tool>('pan');
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<View>({ s: 1, x: 0, y: 0 });
  const [boxes, setBoxes] = useState<Box[] | null>(null);
  const [finding, setFinding] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [rect, setRect] = useState<Box | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number; c: number[] } | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const source = useRef<CanvasRenderingContext2D | null>(null);
  const drag = useRef<{ mode: 'pan' | 'rect'; sx: number; sy: number; vx: number; vy: number; ix: number; iy: number; moved: boolean } | null>(null);

  useEffect(() => {
    setImg(null);
    setError('');
    setBoxes(null);
    setPicked(new Set());
    setRect(null);
    const el = new Image();
    el.onload = () => {
      const c = document.createElement('canvas');
      c.width = el.naturalWidth;
      c.height = el.naturalHeight;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(el, 0, 0);
      source.current = ctx;
      setImg(el);
    };
    el.onerror = async () => {
      const r = await fetch(previewUrl(info));
      setError((await r.json().catch(() => ({}))).error ?? 'не удалось декодировать');
    };
    el.src = previewUrl(info);
  }, [info]);

  // Каналы рисуются из исходника, чтобы пипетка показывала настоящие значения
  useEffect(() => {
    const c = canvas.current;
    const src = source.current;
    if (!c || !img || !src) return;
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d')!;
    const d = src.getImageData(0, 0, c.width, c.height);
    if (channel !== 'rgba') {
      const px = d.data;
      for (let i = 0; i < px.length; i += 4) {
        if (channel === 'rgb') px[i + 3] = 255;
        else {
          px[i] = px[i + 1] = px[i + 2] = px[i + 3];
          px[i + 3] = 255;
        }
      }
    }
    ctx.putImageData(d, 0, 0);
  }, [img, channel]);

  const fit = useCallback(() => {
    const el = stage.current;
    if (!el || !img) return;
    const pad = 24;
    const s = clamp(Math.min((el.clientWidth - pad * 2) / img.naturalWidth, (el.clientHeight - pad * 2) / img.naturalHeight), 0.02, 8);
    setView({ s, x: (el.clientWidth - img.naturalWidth * s) / 2, y: (el.clientHeight - img.naturalHeight * s) / 2 });
  }, [img]);

  const actual = () => {
    const el = stage.current;
    if (!el || !img) return;
    setView({ s: 1, x: (el.clientWidth - img.naturalWidth) / 2, y: (el.clientHeight - img.naturalHeight) / 2 });
  };

  useLayoutEffect(() => fit(), [fit]);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      setView((v) => {
        const s = clamp(v.s * Math.exp(-e.deltaY * 0.0015), 0.02, 40);
        return { s, x: mx - ((mx - v.x) * s) / v.s, y: my - ((my - v.y) * s) / v.s };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const toImage = (e: { clientX: number; clientY: number }) => {
    const r = stage.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.x) / view.s, y: (e.clientY - r.top - view.y) / view.s };
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (!img || (e.button !== 0 && e.button !== 1)) return;
    const p = toImage(e);
    const mode = e.button === 1 || tool === 'pan' ? 'pan' : 'rect';
    drag.current = { mode, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, ix: p.x, iy: p.y, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (e.button === 1) e.preventDefault();
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    if (!img) return;
    const p = toImage(e);
    const ix = Math.floor(p.x);
    const iy = Math.floor(p.y);
    if (ix >= 0 && iy >= 0 && ix < img.naturalWidth && iy < img.naturalHeight && source.current) {
      setCursor({ x: ix, y: iy, c: Array.from(source.current.getImageData(ix, iy, 1, 1).data) });
    } else setCursor(null);
    const d = drag.current;
    if (!d) return;
    if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 3) d.moved = true;
    if (d.mode === 'pan') {
      setView((v) => ({ ...v, x: d.vx + e.clientX - d.sx, y: d.vy + e.clientY - d.sy }));
    } else if (d.moved) {
      const x0 = clamp(Math.min(d.ix, p.x), 0, img.naturalWidth);
      const y0 = clamp(Math.min(d.iy, p.y), 0, img.naturalHeight);
      const x1 = clamp(Math.max(d.ix, p.x), 0, img.naturalWidth);
      const y1 = clamp(Math.max(d.iy, p.y), 0, img.naturalHeight);
      setRect([Math.round(x0), Math.round(y0), Math.round(x1 - x0), Math.round(y1 - y0)]);
    }
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved || !boxes) return;
    // клик без перетаскивания по элементу — выбрать/снять
    const p = toImage(e);
    let hit = -1;
    let best = Infinity;
    boxes.forEach(([x, y, w, h], i) => {
      if (p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h && w * h < best) {
        best = w * h;
        hit = i;
      }
    });
    if (hit >= 0) {
      setPicked((s) => {
        const n = new Set(s);
        if (n.has(hit)) n.delete(hit);
        else n.add(hit);
        return n;
      });
    }
  };

  const findIslands = async () => {
    setFinding(true);
    try {
      const r = await api.islands(info);
      setBoxes(r.boxes);
      setPicked(new Set());
    } finally {
      setFinding(false);
    }
  };

  const exportBoxes = (list: Box[], label: string) => {
    const items: ExportItem[] = list.map((crop, i) => ({ b: info.b, p: info.p, crop, suffix: String(i + 1).padStart(2, '0') }));
    return runExport(label, () => api.export({ items, opts, subdir: list.length > 1 ? info.name || 'Элементы' : '' }));
  };

  if (error) return <div className="center-fill muted">Ошибка: {error}</div>;
  const iw = img?.naturalWidth ?? 0;
  const ih = img?.naturalHeight ?? 0;
  const pickedBoxes = boxes ? [...picked].sort((a, b) => a - b).map((i) => boxes[i]) : [];
  const canIslands = info.props.alpha === 'transparent';

  return (
    <div className="image-preview">
      <div className="toolbar">
        <SegmentedControl aria-label="Инструмент" size="sm" value={tool} onValueChange={(v) => setTool(v as Tool)}
          options={[{ value: 'pan', label: 'Рука' }, { value: 'select', label: 'Выделение' }]} />
        <SegmentedControl aria-label="Каналы" size="sm" value={channel} onValueChange={(v) => setChannel(v as Channel)}
          options={[{ value: 'rgba', label: 'RGBA' }, { value: 'rgb', label: 'RGB' }, { value: 'alpha', label: 'Альфа' }]} />
        <SegmentedControl aria-label="Фон" size="sm" value={bg} onValueChange={(v) => setBg(v as Bg)}
          options={[{ value: 'checker', label: '▦' }, { value: 'dark', label: '■' }, { value: 'light', label: '□' }]} />
        <Button size="sm" variant="ghost" leftIcon={<MaximizeIcon />} onClick={fit}>Вписать</Button>
        <Button size="sm" variant="ghost" onClick={actual}>1:1</Button>
        <span className="muted mono small">{Math.round(view.s * 100)}%</span>
        {canIslands && (
          <Tooltip content="Найти отдельные элементы атласа по прозрачности" placement="bottom">
            <Button size="sm" variant={boxes ? 'secondary' : 'ghost'} leftIcon={<LayersIcon />} loading={finding}
              onClick={boxes ? () => { setBoxes(null); setPicked(new Set()); } : findIslands}>
              {boxes ? `Элементы: ${boxes.length}` : 'Элементы'}
            </Button>
          </Tooltip>
        )}
        <span className="muted mono small push-right pixel-readout">
          {cursor ? (
            <>
              <span className="swatch" style={{ background: `rgba(${cursor.c[0]},${cursor.c[1]},${cursor.c[2]},${cursor.c[3] / 255})` }} />
              {cursor.x},{cursor.y} · {cursor.c.join(' ')}
            </>
          ) : `${iw}×${ih}`}
        </span>
      </div>

      <div ref={stage} className={`viewer-stage bg-${bg} tool-${tool}`} onPointerDown={onPointerDown} onPointerMove={onPointerMove}
        onPointerUp={onPointerUp} onPointerLeave={() => setCursor(null)} onDoubleClick={fit}>
        {!img && <div className="center-fill"><Spinner size={20} /></div>}
        <div className="viewer-content" hidden={!img}
          style={{ width: iw, height: ih, transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` }}>
          <canvas ref={canvas} className={view.s >= 3 ? 'pixelated' : ''} />
          {/* масштаб задан CSS-трансформацией, поэтому толщину линий компенсируем вручную */}
          <svg className="viewer-overlay" viewBox={`0 0 ${iw || 1} ${ih || 1}`} width={iw} height={ih}
            style={{ '--px': `${1 / view.s}px` } as CSSProperties}>
            {boxes?.map(([x, y, w, h], i) => (
              <rect key={i} x={x} y={y} width={w} height={h} className={picked.has(i) ? 'island picked' : 'island'} />
            ))}
            {rect && <rect x={rect[0]} y={rect[1]} width={rect[2]} height={rect[3]} className="selection" />}
          </svg>
        </div>
      </div>

      {(boxes || rect) && (
        <div className="viewer-actions">
          {rect && (
            <>
              <span className="mono small"><TargetIcon size={12} /> {rect[0]},{rect[1]} · {rect[2]}×{rect[3]}</span>
              <Button size="sm" variant="primary" leftIcon={<DownloadIcon />} disabled={rect[2] < 1 || rect[3] < 1}
                onClick={() => exportBoxes([rect], 'Сохраняю выделение…')}>Сохранить выделение</Button>
              <Button size="sm" variant="ghost" leftIcon={<XIcon />} onClick={() => setRect(null)}>Сбросить</Button>
            </>
          )}
          {boxes && (
            <>
              <span className="muted small">{boxes.length ? `Найдено ${boxes.length}, выбрано ${picked.size} — клик по элементу выбирает` : 'Отдельных элементов не найдено'}</span>
              <div className="push-right row-gap">
                {picked.size > 0 && <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>Снять</Button>}
                {boxes.length > 0 && picked.size < boxes.length && (
                  <Button size="sm" variant="ghost" onClick={() => setPicked(new Set(boxes.map((_, i) => i)))}>Выбрать все</Button>
                )}
                <Button size="sm" variant="primary" leftIcon={<DownloadIcon />} disabled={!boxes.length}
                  onClick={() => exportBoxes(picked.size ? pickedBoxes : boxes, 'Сохраняю элементы…')}>
                  {picked.size ? `Сохранить выбранные (${picked.size})` : `Сохранить все (${boxes.length})`}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
