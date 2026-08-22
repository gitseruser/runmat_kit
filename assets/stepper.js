/**
 * Пошаговое исполнение на уровне UI (Фаза 1).
 *
 * Движок не умеет останавливаться между операторами (см. CONTEXT.md, п.6.3),
 * поэтому здесь исходник разбивается на верхнеуровневые операторы (блоки),
 * и каждый блок отправляется в `executeRequest` отдельно. Сессия сохраняет
 * переменные между вызовами, поэтому переменные «переживают» шаги.
 *
 * splitStatements(source) → [{ text, lineFrom, lineTo }]
 *   Блоки (if/for/while/switch/try/parfor/spmd/function…end) шагаются целиком
 *   как ОДИН оператор (step-over). Границы операторов:
 *   - точка с запятой на верхнем уровне (вне () [] {} и строк);
 *   - конец строки, если все скобки закрыты, блоков нет и нет продолжения «...».
 *   Учитываются: строки '…'/"…" (с удвоением кавычек), комментарии %, «...»,
 *   баланс скобок () [] {}, стек блоков, «end» в индексах x(end) (внутри скобок).
 *   Транспонирование A' не путается с началом строки.
 *
 * isFunctionFile(stmts) — файл с функцией верхнего уровня: шаг неприменим.
 * joinFrom(stmts, index) — остаток исходника одним куском («Продолжить»).
 */

const BLOCK_OPEN = new Set([
  "if", "for", "while", "switch", "try", "parfor", "spmd", "function"
]);
const WORD_RE = /[A-Za-z_][A-Za-z0-9_]*/;
const TRANSPOSE_PREV = /[A-Za-z0-9_)\]}\.'"]/;

/**
 * Разбивает исходник на верхнеуровневые операторы.
 * Возвращает массив { text, lineFrom, lineTo } в порядке появления.
 */
export function splitStatements(source) {
  const n = source.length;
  const stmts = [];
  let i = 0;
  let stmtStart = 0; // позиция начала текущего оператора (включая ведущие пробелы)
  let line = 1; // текущая строка
  let stmtLine = 1; // строка начала текущего оператора
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let blocks = 0; // глубина блоков if/for/while/switch/try/parfor/spmd/function
  let sawCode = false; // в текущем операторе уже есть код (не пробел/комментарий)
  let firstTok = true; // следующий токен открывает новый оператор (после ; / строки)
  let inStr = null; // "'" | '"' — открытая строка
  let skipToEol = false; // комментарий % или хвост после «...»
  let cont = false; // было «...»: строка продолжается на следующей
  let lastChar = null; // последний значимый символ (для определения транспонирования)

  const flush = (endExclusive, nextStmtLine) => {
    const text = source.slice(stmtStart, endExclusive).trim();
    if (sawCode && text) {
      stmts.push({ text, lineFrom: stmtLine, lineTo: line });
    }
    sawCode = false;
    firstTok = true;
    stmtStart = endExclusive;
    stmtLine = nextStmtLine;
  };

  while (i < n) {
    const c = source[i];

    // --- внутри строки ---------------------------------------------------
    if (inStr) {
      if (c === "\n" || c === "\r") {
        line++;
        i++;
        continue;
      }
      if (c === inStr) {
        if (source[i + 1] === inStr) {
          i += 2; // удвоенная кавычка — экранирование
          continue;
        }
        lastChar = c;
        inStr = null;
      }
      i++;
      continue;
    }

    // --- комментарий / хвост после «...» --------------------------------
    if (skipToEol) {
      if (c === "\r") {
        i++;
        continue;
      }
      if (c === "\n") {
        if (!cont && paren === 0 && bracket === 0 && brace === 0 && blocks === 0) {
          flush(i, line + 1);
        }
        cont = false;
        skipToEol = false;
        firstTok = true;
        line++;
        lastChar = null;
        i++;
        continue;
      }
      i++;
      continue;
    }

    // --- конец строки ----------------------------------------------------
    if (c === "\n") {
      if (paren === 0 && bracket === 0 && brace === 0 && blocks === 0 && !cont) {
        flush(i, line + 1);
      }
      firstTok = true;
      line++;
      lastChar = null;
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }

    // --- пробелы ---------------------------------------------------------
    if (c === " " || c === "\t" || c === "\f" || c === "\v") {
      i++;
      continue;
    }

    // --- комментарий % ----------------------------------------------------
    if (c === "%") {
      skipToEol = true;
      lastChar = "%";
      i++;
      continue;
    }

    // --- продолжение «...» -------------------------------------------------
    if (c === "." && source[i + 1] === "." && source[i + 2] === ".") {
      cont = true;
      skipToEol = true;
      lastChar = ".";
      i += 3;
      continue;
    }

    // --- кавычки ----------------------------------------------------------
    if (c === "'") {
      // ' — строка, только если предыдущий символ не завершает выражение
      // (иначе это транспонирование A' или .').
      if (lastChar !== null && TRANSPOSE_PREV.test(lastChar)) {
        sawCode = true;
        firstTok = false;
        lastChar = "'";
        i++;
        continue;
      }
      inStr = "'";
      sawCode = true;
      firstTok = false;
      lastChar = "'";
      i++;
      continue;
    }
    if (c === '"') {
      inStr = '"';
      sawCode = true;
      firstTok = false;
      lastChar = '"';
      i++;
      continue;
    }

    // --- точка с запятой на верхнем уровне -------------------------------
    if (c === ";") {
      if (paren === 0 && bracket === 0 && brace === 0 && blocks === 0) {
        flush(i + 1, line); // включаем «;» в текст оператора
      } else {
        sawCode = true;
      }
      firstTok = true; // после «;» начинается новый оператор
      lastChar = ";";
      i++;
      continue;
    }

    // --- слова (ключевые слова блоков, end) ------------------------------
    if (/[A-Za-z_]/.test(c)) {
      const m = WORD_RE.exec(source.slice(i));
      const word = m[0];
      const lower = word.toLowerCase();
      if (paren === 0 && bracket === 0 && brace === 0) {
        if (lower === "end") {
          if (blocks > 0) {
            blocks--;
          }
        } else if (firstTok && BLOCK_OPEN.has(lower)) {
          blocks++;
        }
      }
      sawCode = true;
      firstTok = false;
      lastChar = word[word.length - 1];
      i += word.length;
      continue;
    }

    // --- скобки -----------------------------------------------------------
    if (c === "(") paren++;
    else if (c === ")") paren = Math.max(0, paren - 1);
    else if (c === "[") bracket++;
    else if (c === "]") bracket = Math.max(0, bracket - 1);
    else if (c === "{") brace++;
    else if (c === "}") brace = Math.max(0, brace - 1);

    sawCode = true;
    firstTok = false;
    lastChar = c;
    i++;
  }

  // хвост без закрывающего перевода строки
  flush(n, line);
  return stmts;
}

/**
 * Файл, целиком являющийся функцией верхнего уровня: пооператорное исполнение
 * неприменимо (движок исполняет такой файл как установку функции).
 */
export function isFunctionFile(stmts) {
  return stmts.length === 1 && /^\s*function\b/.test(stmts[0].text);
}

/**
 * Склеивает операторы с index в один кусок («Продолжить»).
 */
export function joinFrom(stmts, index) {
  const rest = stmts.slice(index);
  return rest.map((s) => s.text).join("\n");
}