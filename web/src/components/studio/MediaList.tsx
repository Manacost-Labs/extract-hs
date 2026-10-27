'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/valyro-ui/basic/Button';
import { Spinner } from '@/components/valyro-ui/basic/Spinner';
import { SearchInput } from '@/components/valyro-ui/forms/SearchInput';
import { VirtualList } from '@/components/valyro-ui/layout/VirtualList';
import { SegmentedControl } from '@/components/valyro-ui/navigation/SegmentedControl';
import { ChipGroup } from '@/components/valyro-ui/selection/ChipGroup';
import { CheckIcon, DownloadIcon, ExternalLinkIcon, PauseIcon, PlayIcon, XIcon } from '@/components/valyro-ui/icons';
import { api, assetKey, previewUrl, type AssetRef, type SearchItem, type SearchQuery } from '@/lib/api';
import { groupLabel } from '@/lib/groups';
import { runExport, useExportOpts } from './ExportOptions';
import { useDownload } from './Downloads';
import { TypeIcon } from './icons';

const AUDIO_SETS = [
  { value: '', label: 'Все' },
  { value: 'soundotherminion', label: 'Существа' },
  { value: 'soundspell', label: 'Заклинания' },
  { value: 'soundlegend', label: 'Легендарные' },
  { value: 'playsound', label: 'Розыгрыш' },
  { value: 'soundmission', label: 'Задания' },
  { value: 'musicexpansion,heromusic', label: 'Музыка' },
  { value: 'ui', label: 'Интерфейс' },
];

const PAGE = 500;

/** Список звуков, видео или шрифтов: прослушивание прямо в строке, выбор и скачивание. */
export function MediaList({ type, onOpen }: { type: 'AudioClip' | 'VideoClip' | 'Font'; onOpen: (a: AssetRef & { t: string }) => void }) {
  const download = useDownload();
  const { opts } = useExportOpts();
  const [set, setSet] = useState('');
  const [lang, setLang] = useState('ruru');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<SearchItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Map<string, SearchItem>>(new Map());
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const reqId = useRef(0);
  const isAudio = type === 'AudioClip';

  const query: SearchQuery = useMemo(
    () => ({ q, types: type, groups: isAudio ? set : '', lang: isAudio ? lang : '', sort: 'name' }),
    [q, type, set, lang, isAudio],
  );

  const load = useCallback(async (offset: number) => {
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
  }, [query]);

  useEffect(() => {
    setItems([]);
    void load(0);
  }, [load]);

  useEffect(() => () => audio.current?.pause(), []);

  const play = (it: SearchItem) => {
    const key = assetKey(it);
    if (!audio.current) {
      audio.current = new Audio();
      audio.current.onended = () => setPlaying(null);
    }
    if (playing === key) {
      audio.current.pause();
      setPlaying(null);
      return;
    }
    audio.current.src = previewUrl(it);
    void audio.current.play();
    setPlaying(key);
  };

  const toggleSel = (it: SearchItem) => setSelected((s) => {
    const n = new Map(s);
    const k = assetKey(it);
    if (n.has(k)) n.delete(k);
    else n.set(k, it);
    return n;
  });

  const label = isAudio ? 'звуков' : type === 'VideoClip' ? 'видео' : 'шрифтов';

  return (
    <div className="gallery">
      {isAudio && (
        <div className="gallery-filters">
          <ChipGroup aria-label="Набор звуков" selectionMode="single" size="sm" value={[set]}
            onValueChange={(v) => setSet(v[0] ?? '')} items={AUDIO_SETS} />
          <div className="push-right row-gap">
            <SegmentedControl aria-label="Язык озвучки" size="sm" value={lang} onValueChange={setLang}
              options={[{ value: 'ruru', label: 'RU' }, { value: 'enus', label: 'EN' }, { value: '', label: 'Все' }]} />
            <SearchInput size="sm" placeholder="Фильтр по имени…" value={q} onValueChange={setQ} debounce={250} />
          </div>
        </div>
      )}
      {!isAudio && (
        <div className="gallery-filters">
          <SearchInput size="sm" placeholder="Фильтр по имени…" value={q} onValueChange={setQ} debounce={250} />
        </div>
      )}
      <div className="gallery-grid list">
        {loading && !items.length ? <div className="center-fill"><Spinner size={20} /></div> : (
          <VirtualList
            items={items}
            itemSize={36}
            height="100%"
            variant="plain"
            label={`Список ${label}`}
            getItemKey={(it) => assetKey(it)}
            onEndReached={() => !loading && items.length < total && void load(items.length)}
            loading={loading ? 'end' : false}
            empty={<div className="muted pad">Ничего не найдено</div>}
            renderItem={(it) => {
              const key = assetKey(it);
              const sel = selected.has(key);
              return (
                <div className={`media-row ${sel ? 'selected' : ''} ${playing === key ? 'playing' : ''}`}>
                  <button className="media-check" aria-label="Выбрать" onClick={() => toggleSel(it)}>{sel && <CheckIcon size={12} />}</button>
                  {isAudio ? (
                    <button className="media-play" aria-label={playing === key ? 'Пауза' : 'Слушать'} onClick={() => play(it)}>
                      {playing === key ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
                    </button>
                  ) : <TypeIcon type={type} size={14} />}
                  <span className="media-name ellipsis" title={it.n}>{it.n}</span>
                  <span className="media-group muted small ellipsis" title={it.g}>{groupLabel(it.g)}</span>
                  <button className="row-action" title="Открыть во вкладке" onClick={() => onOpen(it)}><ExternalLinkIcon size={12} /></button>
                  <button className="row-action" title="Скачать"
                    onClick={() => runExport('Экспорт…', () => api.export({ items: [it], opts }))}><DownloadIcon size={12} /></button>
                </div>
              );
            }}
          />
        )}
      </div>
      <div className="gallery-footer">
        <span className="muted">{total.toLocaleString('ru-RU')} {label}{selected.size ? ` · выбрано ${selected.size}` : ''}</span>
        <div className="push-right row-gap">
          {selected.size > 0 && (
            <>
              <Button size="sm" variant="ghost" leftIcon={<XIcon />} onClick={() => setSelected(new Map())}>Снять</Button>
              <Button size="sm" variant="primary" leftIcon={<DownloadIcon />}
                onClick={() => download({ kind: 'items', items: [...selected.values()], label: `выбранные ${label}`, count: selected.size })}>
                Скачать выбранные ({selected.size})
              </Button>
            </>
          )}
          {!selected.size && (
            <Button size="sm" variant="secondary" leftIcon={<DownloadIcon />} disabled={!total}
              onClick={() => download({ kind: 'query', query, label: `${label} по фильтру`, count: total })}>
              Скачать все ({total.toLocaleString('ru-RU')})
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
