'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/valyro-ui/basic/Button';
import { Spinner } from '@/components/valyro-ui/basic/Spinner';
import { Select } from '@/components/valyro-ui/forms/Select';
import { SearchInput } from '@/components/valyro-ui/forms/SearchInput';
import { Slider } from '@/components/valyro-ui/forms/Slider';
import { VirtualList } from '@/components/valyro-ui/layout/VirtualList';
import { ChipGroup } from '@/components/valyro-ui/selection/ChipGroup';
import { Popover } from '@/components/valyro-ui/feedback/Popover';
import { CheckIcon, DownloadIcon, SlidersIcon, XIcon } from '@/components/valyro-ui/icons';
import { api, assetKey, thumbUrl, type AssetRef, type SearchItem, type SearchQuery } from '@/lib/api';
import { groupLabel } from '@/lib/groups';
import { SegmentedControl } from '@/components/valyro-ui/navigation/SegmentedControl';
import { ExportOptions, runExport, useExportOpts } from './ExportOptions';
import { useDownload } from './Downloads';
import { MediaList } from './MediaList';

const PRESETS = [
  { value: 'ui', label: 'Интерфейс' },
  { value: 'cards', label: 'Арт карт' },
  { value: 'portraits', label: 'Портреты и золотые' },
  { value: 'all', label: 'Все' },
];

const PAGE = 300;

type Kind = 'images' | 'AudioClip' | 'VideoClip' | 'Font';

/** Галерея: картинки сеткой; звуки, видео и шрифты списком. */
export function Gallery({ onOpen }: { onOpen: (a: AssetRef & { t: string }) => void }) {
  const [kind, setKind] = useState<Kind>('images');
  return (
    <div className="gallery-shell">
      <div className="gallery-kinds">
        <SegmentedControl aria-label="Что показывать" size="sm" value={kind} onValueChange={(v) => setKind(v as Kind)}
          options={[
            { value: 'images', label: 'Картинки' },
            { value: 'AudioClip', label: 'Звуки' },
            { value: 'VideoClip', label: 'Видео' },
            { value: 'Font', label: 'Шрифты' },
          ]} />
      </div>
      {kind === 'images' ? <ImageGallery onOpen={onOpen} /> : <MediaList key={kind} type={kind} onOpen={onOpen} />}
    </div>
  );
}

function ImageGallery({ onOpen }: { onOpen: (a: AssetRef & { t: string }) => void }) {
  const download = useDownload();
  const [preset, setPreset] = useState('ui');
  const [types, setTypes] = useState<string[]>(['Sprite', 'Texture2D']);
  const [min, setMin] = useState('256');
  const [sort, setSort] = useState<'name' | 'size'>('size');
  const [q, setQ] = useState('');
  const [tile, setTile] = useState(168);
  const [items, setItems] = useState<SearchItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Map<string, SearchItem>>(new Map());
  const { opts } = useExportOpts();
  const [width, setWidth] = useState(800);
  const box = useRef<HTMLDivElement>(null);
  const reqId = useRef(0);

  const query: SearchQuery = useMemo(
    () => ({ q, types: types.join(','), groups: preset === 'all' ? '' : preset, min: Number(min), sort }),
    [q, types, preset, min, sort],
  );

  const load = useCallback(
    async (offset: number) => {
      const id = ++reqId.current;
      setLoading(true);
      try {
        const r = await api.search({ ...query, offset, limit: PAGE });
        if (id !== reqId.current) return;
        setTotal(r.total);
        setItems((prev) => (offset ? [...prev, ...r.items] : r.items));
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    },
    [query],
  );

  useEffect(() => {
    setItems([]);
    void load(0);
  }, [load]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cols = Math.max(1, Math.floor((width - 16) / (tile + 12)));
  const rows = useMemo(() => {
    const out: { id: string; items: SearchItem[] }[] = [];
    for (let i = 0; i < items.length; i += cols) out.push({ id: `r${i}`, items: items.slice(i, i + cols) });
    return out;
  }, [items, cols]);

  const toggleSel = (it: SearchItem) =>
    setSelected((s) => {
      const n = new Map(s);
      const k = assetKey(it);
      if (n.has(k)) n.delete(k);
      else n.set(k, it);
      return n;
    });

  const click = (e: React.MouseEvent, it: SearchItem) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || selected.size) toggleSel(it);
    else onOpen(it);
  };

  const exportSelected = () =>
    runExport(`Экспорт ${selected.size}…`, () => api.export({ items: [...selected.values()], opts, subdir: 'Галерея' }));
  const exportAll = () =>
    download({ kind: 'query', query, label: `картинки «${PRESETS.find((p) => p.value === preset)?.label}»`, count: total });

  return (
    <div className="gallery">
      <div className="gallery-filters">
        <ChipGroup aria-label="Набор" selectionMode="single" size="sm" value={[preset]}
          onValueChange={(v) => v[0] && setPreset(v[0])} items={PRESETS} />
        <ChipGroup aria-label="Типы" size="sm" variant="outline" value={types}
          onValueChange={(v) => v.length && setTypes(v)}
          items={[{ value: 'Sprite', label: 'Спрайты' }, { value: 'Texture2D', label: 'Текстуры' }]} />
        <div className="push-right row-gap">
          <SearchInput size="sm" placeholder="Фильтр по имени…" value={q} onValueChange={setQ} debounce={250} />
          <Select aria-label="Минимальный размер" size="sm" value={min} onValueChange={setMin}
            options={['0', '128', '256', '512', '1024'].map((v) => ({ value: v, label: v === '0' ? 'Любой размер' : `от ${v} px` }))} />
          <Select aria-label="Сортировка" size="sm" value={sort} onValueChange={(v) => setSort(v as 'name' | 'size')}
            options={[{ value: 'size', label: 'Сначала большие' }, { value: 'name', label: 'По имени' }]} />
          <div className="tile-slider">
            <Slider aria-label="Размер плиток" min={100} max={320} step={4} value={tile} onValueChange={(v) => setTile(v as number)} />
          </div>
        </div>
      </div>
      <div className="gallery-grid" ref={box}>
        {loading && !items.length ? (
          <div className="center-fill"><Spinner size={20} /></div>
        ) : (
          <VirtualList
            items={rows}
            itemSize={tile + 46}
            height="100%"
            variant="plain"
            label="Галерея"
            getItemKey={(r) => r.id}
            onEndReached={() => !loading && items.length < total && void load(items.length)}
            loading={loading ? 'end' : false}
            empty={<div className="muted pad">Ничего не найдено — ослабьте фильтры</div>}
            renderItem={(r) => (
              <div className="tile-row" style={{ gridTemplateColumns: `repeat(${cols}, ${tile}px)` }}>
                {r.items.map((it) => {
                  const sel = selected.has(assetKey(it));
                  return (
                    <div key={assetKey(it)} className={`tile ${sel ? 'selected' : ''}`} onClick={(e) => click(e, it)}
                      title={`${it.n}\n${it.w}×${it.h} · ${it.t}\n${groupLabel(it.g)}\n${it.b}`}>
                      <div className="tile-img bg-checker" style={{ height: tile }}>
                        <img loading="lazy" src={thumbUrl(it, tile > 200 ? 384 : 256)} alt={it.n} />
                        <button className="tile-check" aria-label="Выбрать" onClick={(e) => { e.stopPropagation(); toggleSel(it); }}>
                          {sel && <CheckIcon size={12} />}
                        </button>
                      </div>
                      <div className="tile-name ellipsis">{it.n}</div>
                      <div className="tile-meta muted mono">{it.w}×{it.h}</div>
                    </div>
                  );
                })}
              </div>
            )}
          />
        )}
      </div>
      <div className="gallery-footer">
        <span className="muted">{total.toLocaleString('ru-RU')} картинок{selected.size ? ` · выбрано ${selected.size}` : ''}</span>
        <span className="muted small">Клик — открыть, Ctrl+клик — выбрать</span>
        <div className="push-right row-gap">
          <Popover aria-label="Настройки экспорта" placement="top-end" trigger={<Button size="sm" variant="ghost" leftIcon={<SlidersIcon />}>Параметры</Button>}>
            <ExportOptions />
          </Popover>
          {selected.size > 0 && (
            <>
              <Button size="sm" variant="ghost" leftIcon={<XIcon />} onClick={() => setSelected(new Map())}>Снять</Button>
              <Button size="sm" variant="primary" leftIcon={<DownloadIcon />} onClick={exportSelected}>Сохранить выбранные ({selected.size})</Button>
            </>
          )}
          {!selected.size && (
            <Button size="sm" variant="secondary" leftIcon={<DownloadIcon />} onClick={exportAll} disabled={!total}>
              Скачать все ({total.toLocaleString('ru-RU')})
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
