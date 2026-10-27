import type { ReactNode } from 'react';
import {
  ActivityIcon,
  CodeIcon,
  DatabaseIcon,
  FileIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  HashIcon,
  ImageIcon,
  LayersIcon,
  MicIcon,
  PackageIcon,
  PaletteIcon,
  VideoIcon,
} from '@/components/valyro-ui/icons';

const TYPE_ICONS: Record<string, (size: number) => ReactNode> = {
  Texture2D: (s) => <ImageIcon size={s} />,
  Sprite: (s) => <ImageIcon size={s} />,
  AudioClip: (s) => <MicIcon size={s} />,
  VideoClip: (s) => <VideoIcon size={s} />,
  Font: (s) => <HashIcon size={s} />,
  TextAsset: (s) => <FileTextIcon size={s} />,
  Shader: (s) => <CodeIcon size={s} />,
  Mesh: (s) => <LayersIcon size={s} />,
  AnimationClip: (s) => <ActivityIcon size={s} />,
  AnimatorController: (s) => <ActivityIcon size={s} />,
  AnimatorOverrideController: (s) => <ActivityIcon size={s} />,
  Material: (s) => <PaletteIcon size={s} />,
  MonoBehaviour: (s) => <CodeIcon size={s} />,
};

export function TypeIcon({ type, size = 14 }: { type: string; size?: number }) {
  return <span className={`type-icon type-${type}`}>{(TYPE_ICONS[type] ?? ((s) => <FileIcon size={s} />))(size)}</span>;
}

export function FolderGlyph({ open, size = 14 }: { open: boolean; size?: number }) {
  return <span className="type-icon folder">{open ? <FolderOpenIcon size={size} /> : <FolderIcon size={size} />}</span>;
}

export const BundleGlyph = ({ size = 14 }: { size?: number }) => (
  <span className="type-icon bundle"><PackageIcon size={size} /></span>
);

export const TypesGlyph = ({ size = 14 }: { size?: number }) => (
  <span className="type-icon folder"><DatabaseIcon size={size} /></span>
);
