'use client';

import { useEffect, useState } from 'react';
import { CodeBlock } from '@/components/valyro-ui/ai/CodeBlock';
import { Spinner } from '@/components/valyro-ui/basic/Spinner';
import { api, previewUrl, type AssetInfo, type AssetRef } from '@/lib/api';

export function AudioPreview({ asset }: { asset: AssetRef }) {
  return (
    <div className="center-fill">
      <audio controls src={previewUrl(asset)} className="audio" />
    </div>
  );
}

export function VideoPreview({ asset }: { asset: AssetRef }) {
  return (
    <div className="center-fill video-stage">
      <video controls src={previewUrl(asset)} />
    </div>
  );
}

const SAMPLE = 'Таверна открыта! The tavern is open. 0123456789';

export function FontPreview({ asset }: { asset: AssetRef }) {
  const family = `hs-font-${asset.p.replace(/\W/g, '')}`;
  const [ready, setReady] = useState(false);
  const [text, setText] = useState(SAMPLE);
  const [error, setError] = useState('');
  useEffect(() => {
    const face = new FontFace(family, `url(${previewUrl(asset)})`);
    face.load().then((f) => {
      document.fonts.add(f);
      setReady(true);
    }, (e) => setError(String(e)));
  }, [asset, family]);
  if (error) return <div className="center-fill muted">Ошибка: {error}</div>;
  if (!ready) return <div className="center-fill"><Spinner size={20} /></div>;
  return (
    <div className="font-preview">
      <input className="font-sample-input" value={text} onChange={(e) => setText(e.target.value)} aria-label="Текст примера" />
      {[96, 64, 40, 24, 16].map((s) => (
        <div key={s} className="font-line" style={{ fontFamily: family, fontSize: s }}>
          <span className="font-size mono">{s}</span>{text}
        </div>
      ))}
      <div className="font-line glyphs" style={{ fontFamily: family, fontSize: 28 }}>
        АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ абвгдеёжзийклмнопрстуфхцчшщъыьэюя ABCDEFGHIJKLMNOPQRSTUVWXYZ
        abcdefghijklmnopqrstuvwxyz 0123456789 !?.,:;()[]{}+-*/=%&@#
      </div>
    </div>
  );
}

const LANG: Record<string, string | undefined> = { Shader: undefined, Mesh: undefined, TextAsset: undefined };

export function TextPreview({ info }: { info: AssetInfo }) {
  const [state, setState] = useState<{ text: string; truncated: boolean; length: number } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setState(null);
    api.text(info).then(setState, (e) => setError(e.message));
  }, [info]);
  if (error) return <div className="center-fill muted">Ошибка: {error}</div>;
  if (!state) return <div className="center-fill"><Spinner size={20} /></div>;
  const lang = info.name.endsWith('.json') ? 'json' : info.name.endsWith('.xml') ? 'xml' : LANG[info.type];
  return (
    <div className="text-preview">
      {state.truncated && <div className="notice">Показано {state.text.length.toLocaleString('ru-RU')} из {state.length.toLocaleString('ru-RU')} символов — полностью через экспорт.</div>}
      {state.text.length < 150_000 ? (
        <CodeBlock code={state.text} language={lang} filename={info.name || info.type} showLineNumbers maxHeight="100%" />
      ) : (
        <pre className="plain-text">{state.text}</pre>
      )}
    </div>
  );
}
