'use client';

import { useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon } from '@/components/valyro-ui/icons';
import type { AssetRef } from '@/lib/api';
import { TypeIcon } from './icons';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Ref = { b?: string; p: string; t?: string; n?: string; ext?: string };

const CHUNK = 200;

const isRef = (v: Json): v is { m_FileID: number; m_PathID: string; $ref: Json } =>
  !!v && typeof v === 'object' && !Array.isArray(v) && 'm_PathID' in v && 'm_FileID' in v;

function Scalar({ value }: { value: Json }) {
  if (value === null) return <span className="j-null">null</span>;
  if (typeof value === 'string') return <span className="j-str">&quot;{value}&quot;</span>;
  if (typeof value === 'number') return <span className="j-num">{value}</span>;
  if (typeof value === 'boolean') return <span className="j-bool">{String(value)}</span>;
  return null;
}

function RefLink({ value, onOpen }: { value: { m_FileID: number; m_PathID: string; $ref?: Json }; onOpen: (r: AssetRef) => void }) {
  const ref = value.$ref as Ref | undefined;
  if (value.m_PathID === '0' || !ref) return <span className="j-null">null ref</span>;
  if (!ref.b) return <span className="j-null" title={ref.ext}>внешний: {ref.ext?.split('/').pop()} #{ref.p}</span>;
  return (
    <button className="j-ref" onClick={() => onOpen({ b: ref.b!, p: ref.p, t: ref.t, n: ref.n })} title={`${ref.b} #${ref.p}`}>
      {ref.t && <TypeIcon type={ref.t} size={12} />}
      {ref.n || ref.t || 'объект'} <span className="muted">#{ref.p.slice(-6)}</span>
    </button>
  );
}

function Node({ name, value, depth, onOpen }: { name: string | null; value: Json; depth: number; onOpen: (r: AssetRef) => void }) {
  const composite = value !== null && typeof value === 'object' && !isRef(value);
  const [open, setOpen] = useState(depth < 2);
  const [shown, setShown] = useState(CHUNK);
  const key = name !== null && <span className="j-key">{name}: </span>;

  if (!composite) {
    return (
      <div className="j-line" style={{ paddingLeft: depth * 14 + 14 }}>
        {key}
        {isRef(value) ? <RefLink value={value} onOpen={onOpen} /> : <Scalar value={value} />}
      </div>
    );
  }
  const entries: [string, Json][] = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, Json>);
  const summary = Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`;
  return (
    <>
      <div className="j-line j-branch" style={{ paddingLeft: depth * 14 }} onClick={() => setOpen(!open)}>
        <span className="j-chevron">{open ? <ChevronDownIcon size={11} /> : <ChevronRightIcon size={11} />}</span>
        {key}
        <span className="muted">{summary}</span>
      </div>
      {open && (
        <>
          {entries.slice(0, shown).map(([k, v]) => (
            <Node key={k} name={k} value={v} depth={depth + 1} onOpen={onOpen} />
          ))}
          {entries.length > shown && (
            <div className="j-line" style={{ paddingLeft: (depth + 1) * 14 + 14 }}>
              <button className="j-more" onClick={() => setShown(shown + CHUNK)}>
                показать ещё {Math.min(CHUNK, entries.length - shown)} из {entries.length - shown}
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}

export function JsonTree({ data, onOpen }: { data: unknown; onOpen: (r: AssetRef) => void }) {
  return (
    <div className="json-tree">
      <Node name={null} value={data as Json} depth={0} onOpen={onOpen} />
    </div>
  );
}
