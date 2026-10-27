'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/valyro-ui/basic/Badge';
import { Button } from '@/components/valyro-ui/basic/Button';
import { IconButton } from '@/components/valyro-ui/basic/IconButton';
import { ProgressBar } from '@/components/valyro-ui/basic/ProgressBar';
import { Tooltip } from '@/components/valyro-ui/basic/Tooltip';
import { SearchInput } from '@/components/valyro-ui/forms/SearchInput';
import { TextInput } from '@/components/valyro-ui/forms/TextInput';
import { Popover } from '@/components/valyro-ui/feedback/Popover';
import { ExportOptsProvider } from './ExportOptions';
import { DownloadAllDialog, useDownload } from './Downloads';
import { GameDirForm, GameDirSetting, GameSetup } from './GameDir';
import { ConfirmDialogHost } from '@/components/valyro-ui/feedback/ConfirmDialog';
import { ResizablePanels } from '@/components/valyro-ui/layout/ResizablePanels';
import { toast } from '@/components/valyro-ui/feedback/toast-store';
import { DownloadIcon, FolderOpenIcon, GridIcon, RefreshIcon, XIcon } from '@/components/valyro-ui/icons';
import { api, assetKey, type AssetRef, type Status } from '@/lib/api';
import { AssetView, useAssetInfo } from './AssetView';
import { Explorer } from './Explorer';
import { Gallery } from './Gallery';
import { Inspector } from './Inspector';
import { TypeIcon } from './icons';

type Tab = { id: string; kind: 'gallery' } | { id: string; kind: 'asset'; ref: AssetRef & { t?: string } };

const GALLERY: Tab = { id: 'gallery', kind: 'gallery' };

function ExportDirSetting({ current, onChanged }: { current: string; onChanged: (dir: string) => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(current);
  useEffect(() => setValue(current), [current, open]);
  const save = async () => {
    try {
      const r = await api.settings(value.trim());
      onChanged(r.exportDir);
      setOpen(false);
      toast.success('Папка экспорта изменена', { description: r.exportDir });
    } catch (e) {
      toast.error('Не удалось сменить папку', { description: (e as Error).message });
    }
  };
  return (
    <Popover aria-label="Папка экспорта" placement="top-end" open={open} onOpenChange={setOpen}
      trigger={<button className="link">Экспорт: {current}</button>}>
      <div className="dir-setting">
        <div className="section-label">Папка экспорта</div>
        <TextInput size="sm" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Путь к папке"
          onKeyDown={(e) => e.key === 'Enter' && void save()} />
        <div className="row-gap">
          <Button size="sm" variant="primary" onClick={save} disabled={!value.trim() || value.trim() === current}>Сохранить</Button>
          <Button size="sm" variant="ghost" leftIcon={<FolderOpenIcon />} onClick={() => void api.reveal()}>Открыть</Button>
        </div>
      </div>
    </Popover>
  );
}

function useStatus() {
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let alive = true;
    const tick = async () => {
      try {
        const s = await api.status();
        if (!alive) return;
        setStatus(s);
        timer = setTimeout(tick, s.state === 'indexing' || !s.ready ? 700 : 15000);
      } catch {
        timer = setTimeout(tick, 2000);
      }
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);
  return [status, setStatus] as const;
}

export function Studio() {
  return (
    <ExportOptsProvider>
      <Workbench />
    </ExportOptsProvider>
  );
}

function Workbench() {
  const [status, setStatus] = useStatus();
  const download = useDownload();
  const [downloadAll, setDownloadAll] = useState(false);
  const [query, setQuery] = useState('');
  const [tabs, setTabs] = useState<Tab[]>([GALLERY]);
  const [active, setActive] = useState('gallery');

  const open = useCallback((ref: AssetRef & { t?: string }) => {
    const id = assetKey(ref);
    setTabs((ts) => (ts.some((t) => t.id === id) ? ts : [...ts, { id, kind: 'asset', ref }]));
    setActive(id);
  }, []);

  const close = (id: string) => {
    setTabs((ts) => {
      const i = ts.findIndex((t) => t.id === id);
      const next = ts.filter((t) => t.id !== id);
      if (id === active) setActive(next[Math.max(0, i - 1)]?.id ?? '');
      return next;
    });
  };

  const openGallery = () => {
    setTabs((ts) => (ts.some((t) => t.id === 'gallery') ? ts : [GALLERY, ...ts]));
    setActive('gallery');
  };

  const activeTab = tabs.find((t) => t.id === active);
  const activeRef = useMemo(() => (activeTab?.kind === 'asset' ? activeTab.ref : null), [activeTab]);
  const { info, error } = useAssetInfo(activeRef);

  const reindex = async () => {
    await api.reindex();
    toast.info('Переиндексация запущена');
  };

  if (!status) return <div className="boot muted">Подключаюсь к серверу…</div>;
  if (!status.ready) {
    return (
      <div className="boot">
        {status.state === 'nogame' ? <GameSetup /> : (
          <div className="boot-card">
            <h1>Hearthstone Asset Studio</h1>
            {status.state === 'error' ? (
              <>
                <p className="danger">Ошибка индексации: {status.message}</p>
                <GameDirForm initial={status.game} />
              </>
            ) : (
              <>
                <p className="muted">Составляю индекс ресурсов игры ({status.game}). Это займёт пару минут, повторно — не нужно.</p>
                <ProgressBar value={status.done} max={status.total || 1} label="Бандлы" showValue
                  formatValue={(v, m) => `${v} из ${m}`} />
              </>
            )}
          </div>
        )}
      </div>
    );
  }

  const counts = status.counts ?? {};
  return (
    <div className="studio">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◆</span> Hearthstone Asset Studio
        </div>
        <div className="topbar-search">
          <SearchInput size="sm" placeholder="Поиск ассетов по имени…" value={query} onValueChange={setQuery}
            debounce={250} shortcut="mod+k" globalShortcut />
        </div>
        <div className="row-gap">
          <Button size="sm" variant={active === 'gallery' ? 'secondary' : 'ghost'} leftIcon={<GridIcon />} onClick={openGallery}>
            Галерея
          </Button>
          <Button size="sm" variant="primary" leftIcon={<DownloadIcon />} onClick={() => setDownloadAll(true)}>
            Скачать всё
          </Button>
          <Tooltip content={`Папка экспорта: ${status.exportDir}`} placement="bottom">
            <IconButton size="sm" icon={<FolderOpenIcon />} label="Открыть папку экспорта" onClick={() => void api.reveal()} />
          </Tooltip>
        </div>
      </header>

      <ResizablePanels direction="horizontal" autoSaveId="studio-layout" className="workbench">
        <ResizablePanels.Panel id="explorer" defaultSize={22} minSize="200px" collapsible collapsedSize="0px">
          <Explorer query={query} activeKey={activeRef ? assetKey(activeRef) : null} onOpen={open} onDownload={(a) => void download(a)} />
        </ResizablePanels.Panel>
        <ResizablePanels.Handle label="Ширина проводника" />
        <ResizablePanels.Panel id="editor" defaultSize={56} minSize="320px">
          <div className="editor">
            <div className="tabstrip" role="tablist" aria-label="Открытые ассеты">
              {tabs.map((t) => (
                <div key={t.id} className={`tab ${t.id === active ? 'active' : ''}`}
                  onMouseDown={(e) => e.button === 1 && (e.preventDefault(), close(t.id))}>
                  <button role="tab" aria-selected={t.id === active} className="tab-btn" onClick={() => setActive(t.id)}
                    title={t.kind === 'asset' ? `${t.ref.t ?? ''} · ${t.ref.b}` : 'Галерея'}>
                    {t.kind === 'gallery' ? <GridIcon size={13} /> : <TypeIcon type={t.ref.t ?? ''} size={13} />}
                    <span className="ellipsis">{t.kind === 'gallery' ? 'Галерея' : t.ref.n || `#${t.ref.p.slice(-6)}`}</span>
                  </button>
                  <button className="tab-close" aria-label="Закрыть вкладку" onClick={() => close(t.id)}><XIcon size={12} /></button>
                </div>
              ))}
            </div>
            <div className="editor-body">
              {activeTab?.kind === 'gallery' && <Gallery onOpen={open} />}
              {activeTab?.kind === 'asset' && <AssetView key={activeTab.id} info={info} error={error} onOpen={open} />}
              {!activeTab && (
                <div className="center-fill muted">
                  Откройте ассет в проводнике или <button className="link" onClick={openGallery}>галерею</button>
                </div>
              )}
            </div>
          </div>
        </ResizablePanels.Panel>
        <ResizablePanels.Handle label="Ширина свойств" />
        <ResizablePanels.Panel id="inspector" defaultSize={22} minSize="240px" collapsible collapsedSize="0px">
          <Inspector info={activeTab?.kind === 'asset' ? info : null} onOpen={open} />
        </ResizablePanels.Panel>
      </ResizablePanels>

      <DownloadAllDialog open={downloadAll} onOpenChange={setDownloadAll} />
      <ConfirmDialogHost />
      <footer className="statusbar">
        <GameDirSetting current={status.game} />
        <span>Unity {status.unity}</span>
        <span>{(counts.Texture2D ?? 0).toLocaleString('ru-RU')} текстур</span>
        <span>{(counts.Sprite ?? 0).toLocaleString('ru-RU')} спрайтов</span>
        <span>{(counts.AudioClip ?? 0).toLocaleString('ru-RU')} звуков</span>
        <span>{(counts.AnimationClip ?? 0).toLocaleString('ru-RU')} анимаций</span>
        {status.state === 'indexing' && <Badge size="sm" color="amber">индексация {status.done}/{status.total}</Badge>}
        <span className="push-right">
          <ExportDirSetting current={status.exportDir} onChanged={(d) => setStatus({ ...status, exportDir: d })} />
        </span>
        <button className="link" onClick={reindex}><RefreshIcon size={11} /> Переиндексировать</button>
      </footer>
    </div>
  );
}
