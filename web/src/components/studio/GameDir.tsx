'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/valyro-ui/basic/Button';
import { TextInput } from '@/components/valyro-ui/forms/TextInput';
import { Popover } from '@/components/valyro-ui/feedback/Popover';
import { toast } from '@/components/valyro-ui/feedback/toast-store';
import { FolderOpenIcon } from '@/components/valyro-ui/icons';
import { api } from '@/lib/api';

/** Поле пути к игре: ввод вручную или системный диалог «Обзор…». */
export function GameDirForm({ initial = '', onDone }: { initial?: string; onDone?: (game: string) => void }) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const apply = async (path: string) => {
    if (!path.trim()) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.setGame(path.trim());
      setValue(r.game);
      onDone?.(r.game);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const browse = async () => {
    const r = await api.pickGame().catch(() => ({ path: '' }));
    if (r.path) {
      setValue(r.path);
      void apply(r.path);
    }
  };

  return (
    <div className="dir-setting">
      <div className="row-gap">
        <TextInput size="sm" value={value} placeholder="Например: C:\Program Files (x86)\Hearthstone" aria-label="Папка игры"
          onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void apply(value)}
          invalid={!!error} style={{ flex: 1 }} />
        <Button size="sm" variant="secondary" leftIcon={<FolderOpenIcon />} onClick={browse}>Обзор…</Button>
      </div>
      {error && <div className="danger small">{error}</div>}
      <Button size="sm" variant="primary" loading={busy} disabled={!value.trim()} onClick={() => apply(value)}>
        Использовать эту папку
      </Button>
    </div>
  );
}

/** Экран первого запуска, если игра не нашлась автоматически. */
export function GameSetup() {
  return (
    <div className="boot-card">
      <h1>Hearthstone Asset Studio</h1>
      <p>Не удалось найти Hearthstone автоматически.</p>
      <p className="muted small">Укажите папку, где установлена игра: в ней лежат <span className="mono">Hearthstone.exe</span> и
        папка <span className="mono">Hearthstone_Data</span>. Узнать её можно в Battle.net: шестерёнка у кнопки «Играть» →
        «Показать в проводнике».</p>
      <GameDirForm />
    </div>
  );
}

/** Путь к игре в статус-баре: клик — сменить папку. */
export function GameDirSetting({ current }: { current: string }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(0);
  useEffect(() => setKey((k) => k + 1), [open]);
  return (
    <Popover aria-label="Папка игры" placement="top-start" open={open} onOpenChange={setOpen}
      trigger={<button className="link" title="Сменить папку игры">{current}</button>}>
      <div className="dir-setting">
        <div className="section-label">Папка игры</div>
        <GameDirForm key={key} initial={current} onDone={(g) => {
          setOpen(false);
          toast.success('Папка игры изменена', { description: `${g} — индекс обновится, если игра другая` });
        }} />
      </div>
    </Popover>
  );
}
