// Человекочитаемые названия групп бандлов: <содержимое>_<раздел>[_<качество>]_<язык>

const CONTENT: Record<string, string> = {
  initial: 'Основные ресурсы',
  essential: 'Базовые (при запуске)',
  cardtexture: 'Арт карт',
  cardasset: 'Ассеты карт',
  carddef: 'Описания карт',
  portpremium: 'Портреты и золотые',
  porthigh: 'Портреты HD',
  soundotherminion: 'Звуки существ',
  soundmission: 'Звуки заданий',
  soundspell: 'Звуки заклинаний',
  soundlegend: 'Звуки легендарных',
  playsound: 'Звуки розыгрыша',
  musicexpansion: 'Музыка дополнений',
  heromusic: 'Музыка героев',
  video: 'Видео',
  font: 'Шрифты',
  dbf: 'База данных',
  asset: 'Манифест',
};

const SECTION: Record<string, string> = {
  base: '',
  adventure: 'Приключения',
  bgs: 'Поля сражений',
  merc: 'Наёмники',
  tb: 'Потасовки',
  duels: 'Дуэли',
  arena: 'Арена',
  qualityhigh: 'высокое качество',
  qualitylow: 'низкое качество',
};

const LOCALE = /^[a-z]{2}[a-z]{2}$/;

export function groupLabel(group: string): string {
  const [content, ...rest] = group.split('_');
  const parts: string[] = [CONTENT[content] ?? content];
  for (const tag of rest) {
    if (tag === 'global') continue;
    if (tag in SECTION) {
      if (SECTION[tag]) parts.push(SECTION[tag]);
    } else if (LOCALE.test(tag)) {
      parts.push(tag.slice(2).toUpperCase());
    } else {
      parts.push(tag.toUpperCase());
    }
  }
  return parts.join(' · ');
}
