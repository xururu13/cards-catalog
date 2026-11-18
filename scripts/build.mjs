import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { parse } from 'yaml';

const maxSetBytes = 2 * 1024 * 1024;
const maxIndexBytes = 256 * 1024;
const setId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const language = /^(ru(?:-ru)?|en(?:-us)?)$/i;
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

function requiredText(value, label, max = Infinity) {
  const text = ['string', 'number', 'boolean'].includes(typeof value) ? String(value).trim() : '';
  if (!text || text.length > max) throw new Error(label + ': недопустимый текст');
  return text;
}

function nonemptyArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(label + ': пустой список');
  return value;
}

function readSet(bytes) {
  const set = parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!isObject(set)) throw new Error('Набор должен быть объектом');
  if ((set.format !== undefined && set.format !== 'kartochki-catalog') ||
      (set.version !== undefined && set.version !== 1)) {
    throw new Error('Неизвестный формат или версия набора');
  }
  if (typeof set.id !== 'string' || set.id.length > 80 || !setId.test(set.id)) {
    throw new Error('Укажите постоянный id из строчных латинских букв, цифр и дефисов (до 80 знаков)');
  }

  const title = requiredText(set.title, 'Название набора', 200);
  const source = set.source == null ? undefined : requiredText(set.source, 'Источник', 500);
  for (const field of ['frontLang', 'backLang']) {
    if (set[field] != null && !language.test(requiredText(set[field], field))) {
      throw new Error('Неподдерживаемый язык в ' + field);
    }
  }

  const numbers = new Set();
  const terms = new Set();
  let sectionCount = 0;
  for (const chapter of nonemptyArray(set.chapters, 'Главы')) {
    const chapterTitle = requiredText(chapter?.title, 'Название главы');
    for (const section of nonemptyArray(chapter.sections, chapterTitle + ', параграфы')) {
      const sectionTitle = requiredText(section?.title, 'Название параграфа');
      const number = section.number;
      if (number != null) {
        if (!Number.isInteger(number) || number < 0 || numbers.has(number)) {
          throw new Error(sectionTitle + ': неверный или повторяющийся номер параграфа');
        }
        numbers.add(number);
      }
      sectionCount++;
      const raw = section.cards;
      const cards = Array.isArray(raw) ? raw.map((card) => [card?.front, card?.back])
        : isObject(raw) ? Object.entries(raw) : [];
      for (const [front, back] of nonemptyArray(cards, sectionTitle + ', карточки')) {
        const term = requiredText(front, 'Термин', 200);
        requiredText(back, 'Определение для «' + term + '»', 1000);
        const key = term.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
        if (terms.has(key)) throw new Error('Термин «' + term + '» повторяется');
        terms.add(key);
      }
    }
  }

  return {
    id: set.id,
    title,
    source,
    sectionCount,
    cardCount: terms.size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function assetPath(entry) {
  return 'sets/' + entry.id + '-' + entry.sha256 + '.yaml';
}

function escapeHtml(text) {
  return text.replace(/[&<>]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]);
}

const sourceDirectory = new URL('../sets/', import.meta.url);
const outputDirectory = new URL('../dist/', import.meta.url);
const catalog = new Map();
for (const file of await readdir(sourceDirectory, { withFileTypes: true })) {
  if (!/\.ya?ml$/i.test(file.name)) continue;
  try {
    const path = new URL(encodeURIComponent(file.name), sourceDirectory);
    if (!file.isFile() || (await stat(path)).size > maxSetBytes) {
      throw new Error('Ожидали обычный YAML-файл размером до 2 МиБ');
    }
    const bytes = await readFile(path);
    const entry = readSet(bytes);
    if (catalog.has(entry.id)) throw new Error('Повторяется id ' + entry.id);
    catalog.set(entry.id, { entry, bytes });
  } catch (error) {
    throw new Error(file.name + ': ' + error.message, { cause: error });
  }
}

const records = [...catalog.values()].sort((a, b) => a.entry.title.localeCompare(b.entry.title, 'ru'));
const index = JSON.stringify({ version: 1, sets: records.map(({ entry }) => entry) }, null, 2) + '\n';
if (Buffer.byteLength(index) > maxIndexBytes) throw new Error('Индекс превышает 256 КиБ');

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(new URL('sets/', outputDirectory), { recursive: true });
await writeFile(new URL('catalog.json', outputDirectory), index);
for (const { entry, bytes } of records) {
  await writeFile(new URL(assetPath(entry), outputDirectory), bytes);
}

const links = records.map(({ entry }) =>
  '<li><a href="' + assetPath(entry) + '">' + escapeHtml(entry.title) + '</a> — ' + entry.cardCount + ' карт.</li>',
);
const html = [
  '<!doctype html>',
  '<html lang="ru">',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<title>Наборы карточек</title>',
  '<main>',
  '<h1>Наборы карточек</h1>',
  '<p>В приложении выбери «Наборы карточек» → «Импорт из онлайн-каталога».</p>',
  '<ul>',
  ...links,
  '</ul>',
  '</main>',
  '</html>',
].join('\n');
await writeFile(new URL('index.html', outputDirectory), html + '\n');
console.log('Наборов в каталоге: ' + records.length);
