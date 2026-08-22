/**
 * RunMat Web — интерфейс (рабочая копия комплекта runmat_kit).
 *
 * Структура файла (основные функциональные блоки):
 *   1. Импорты       — wasm-glue (runmat-wasm.js), редактор (editor-lib.js), темы (themes.js).
 *   2. modulepreload — полифил + __vitePreload (артефакты исходной Vite-сборки).
 *   3. RunSession    — тонкая обёртка над wasm-сессией (инициализация, executeRequest, потоки).
 *   4. createEditor  — редактор CodeMirror 6: подсветка Octave (StreamLanguage), хоткеи,
 *                      переключение тем через themeCompartment.
 *   5. ConsolePane   — панель консоли/вывода: потоки stdout/stderr/display/err, автопрокрутка,
 *                      строка ввода REPL с историей и многострочным буфером.
 *   6. isInputComplete — проверка полноты введённой конструкции (скобки/строки/блоки if-for-end).
 *   7. VariablesPane — панель переменных: приём дельт workspace от ядра и их слияние в зеркало.
 *   8. PlotsPane     — вкладка графиков: рендер фигур через renderFigureImage (wasm) в <img>.
 *   9. FilesPane     — дерево файлов (виртуальная ФС провайдера).
 *  10. FsaFilesystemProvider — провайдер ФС через File System Access API (Chrome/Edge).
 *  11. main()        — связывание всего: сессия, панели, редактор, тулбар, обработчики.
 *                     Пошаговый режим (Фаза 1): splitStatements (stepper.js) разбивает
 *                     исходник на верхнеуровневые операторы; каждый шаг отправляет один
 *                     оператор в executeRequest, подсветка показывает планируемый блок.
 *  12. DEMO_FILES / seedDemo — демо-проект при первом запуске (hello.m, linalg.m, plots_demo.m).
 */
import {
  i as initRunMat,
  s as subscribeStdout,
  u as unsubscribeStdout,
  _ as __wbg_init,
  a as __internals,
  w as wasmWeb,
  r as renderFigureImage,
  c as createDefaultFsProvider
} from "./runmat-wasm.js";
import {
  Compartment,
  Decoration,
  EditorState,
  EditorView,
  StateEffect,
  StateField,
  StreamLanguage,
  WidgetType,
  basicSetup,
  indentUnit,
  keymap
} from "./editor-lib.js";
import { lightTheme, monokaiTheme } from "./themes.js";
import { splitStatements, isFunctionFile, joinFrom } from "./stepper.js";
(function polyfill() {
  const relList = document.createElement("link").relList;
  if (relList && relList.supports && relList.supports("modulepreload")) {
    return;
  }
  for (const link of document.querySelectorAll('link[rel="modulepreload"]')) {
    processPreload(link);
  }
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type !== "childList") {
        continue;
      }
      for (const node of mutation.addedNodes) {
        if (node.tagName === "LINK" && node.rel === "modulepreload")
          processPreload(node);
      }
    }
  }).observe(document, {
    childList: true,
    subtree: true
  });

  function getFetchOpts(link) {
    const fetchOpts = {};
    if (link.integrity) fetchOpts.integrity = link.integrity;
    if (link.referrerPolicy) fetchOpts.referrerPolicy = link.referrerPolicy;
    if (link.crossOrigin === "use-credentials")
      fetchOpts.credentials = "include";
    else if (link.crossOrigin === "anonymous") fetchOpts.credentials = "omit";
    else fetchOpts.credentials = "same-origin";
    return fetchOpts;
  }

  function processPreload(link) {
    if (link.ep)
      return;
    link.ep = true;
    const fetchOpts = getFetchOpts(link);
    fetch(link.href, fetchOpts);
  }
})();
let nativeModulePromise = null;
async function ensureNativeModule() {
  if (!nativeModulePromise) {
    nativeModulePromise = (async () => {
      await __wbg_init();
      __internals.setNativeModuleOverride(wasmWeb);
    })();
  }
  await nativeModulePromise;
}

// Хранилище состояния JIT-тумблера между сессиями (читается до initRunMat,
// на уровне модуля — нужно и в RunSession.init, и в хуке onReady).
function loadJit() {
  try {
    return localStorage.getItem("runmat.settings.jitEnabled") === "1";
  } catch (_) {
    return false;
  }
}
function saveJit(value) {
  try {
    localStorage.setItem("runmat.settings.jitEnabled", value ? "1" : "0");
  } catch (_) {}
}

class RunSession {
  /**
   * Обёртка над wasm-сессией RunMat.
   * - init(): грузит wasm-модуль, создаёт сессию initRunMat, подписывается на stdout,
   *   регистрирует обработчик интерактивного ввода input() (через window.prompt).
   * - run(source): executeRequest({source}) — единственная точка исполнения кода;
   *   результат целиком отдаётся в hooks.onExecuted (outcome содержит error, workspace,
   *   streams, figuresTouched, displayEvents и т.д.).
   * - workspaceSnapshot()/materialize(): чтение снапшота переменных и значений по имени.
   * - clearWorkspace()/setFsProvider()/teardown(): обслуживание сессии.
   */
  constructor(hooks) {
    this.hooks = hooks;
  }
  session = null;
  stdoutSub = null;
  async init(fsProvider) {
    this.teardown();
    try {
      await ensureNativeModule();
      this.session = await initRunMat({
        fsProvider,
        telemetryConsent: false,
        enableJit: loadJit()
      });
      this.stdoutSub = await subscribeStdout((entry) => this.hooks.onStdout(entry));
      await this.session.setInputHandler(async (req) => {
        if (req.kind === "line") {
          const value = window.prompt(req.prompt);
          return value ?? "";
        }
        return {
          kind: "keyPress"
        };
      });
      // Native-шаг (Фаза 2): если сборка wasm экспортирует setStepHandler,
      // регистрируем хендлер, который возвращает решение (next/continue/stop)
      // для пауз интерпретатора на границах операторов.
      if (typeof this.session.setStepHandler === "function") {
        await this.session.setStepHandler(async (req) => {
          if (typeof this.hooks.onStepRequest === "function") {
            return this.hooks.onStepRequest(req);
          }
          return "continue";
        });
      }
      this.hooks.onReady(this.session.gpuStatus());
    } catch (e) {
      this.hooks.onError(`Не удалось инициализировать runtime: ${describeError(e)}`);
      throw e;
    }
  }
  async run(source) {
    if (!this.session) {
      this.hooks.onError("Runtime ещё не готов.");
      return;
    }
    this.hooks.onBusy(true);
    try {
      const result = await this.session.executeRequest({
        source
      });
      this.hooks.onExecuted(result);
    } catch (e) {
      this.hooks.onError(describeError(e));
    } finally {
      this.hooks.onBusy(false);
    }
  }
  async runStep(source) {
    if (!this.session) {
      this.hooks.onError("Runtime ещё не готов.");
      return;
    }
    this.hooks.onBusy(true);
    try {
      const result = await this.session.executeRequest({
        source,
        stepMode: true
      });
      this.hooks.onExecuted(result);
    } catch (e) {
      this.hooks.onError(describeError(e));
    } finally {
      this.hooks.onBusy(false);
    }
  }
  supportsNativeStep() {
    return !!this.session && typeof this.session.setStepHandler === "function";
  }
  async workspaceSnapshot() {
    return this.session?.workspaceSnapshot();
  }
  async materialize(selector, options) {
    return this.session?.materializeVariable(selector, options);
  }
  clearWorkspace() {
    this.session?.clearWorkspace();
  }
  async setFsProvider(provider) {
    if (!this.session) {
      return;
    }
    if (typeof this.session.setFsProvider === "function") {
      await this.session.setFsProvider(provider);
    } else {
      await this.init(provider);
    }
  }
  gpuStatus() {
    return this.session ? this.session.gpuStatus() : null;
  }
  teardown() {
    if (this.stdoutSub != null) {
      void unsubscribeStdout(this.stdoutSub).catch(() => void 0);
      this.stdoutSub = null;
    }
    if (this.session) {
      this.session.dispose();
      this.session = null;
    }
  }
}

function describeError(e) {
  if (e instanceof Error) {
    const details = e.diagnostic;
    return details || e.message;
  }
  return String(e);
}
const scriptRel = "modulepreload";
const assetsURL = function(dep, importerUrl) {
  return new URL(dep, importerUrl).href;
};
const seen = {};
const __vitePreload = function preload(baseModule, deps, importerUrl) {
  let promise = Promise.resolve();
  if (deps && deps.length > 0) {
    let allSettled2 = function(promises) {
      return Promise.all(
        promises.map(
          (p) => Promise.resolve(p).then(
            (value) => ({
              status: "fulfilled",
              value
            }),
            (reason) => ({
              status: "rejected",
              reason
            })
          )
        )
      );
    };
    const links = document.getElementsByTagName("link");
    const cspNonceMeta = document.querySelector(
      "meta[property=csp-nonce]"
    );
    const cspNonce = cspNonceMeta?.nonce || cspNonceMeta?.getAttribute("nonce");
    promise = allSettled2(
      deps.map((dep) => {
        dep = assetsURL(dep, importerUrl);
        if (dep in seen) return;
        seen[dep] = true;
        const isCss = dep.endsWith(".css");
        const cssSelector = isCss ? '[rel="stylesheet"]' : "";
        const isBaseRelative = !!importerUrl;
        if (isBaseRelative) {
          for (let i = links.length - 1; i >= 0; i--) {
            const link2 = links[i];
            if (link2.href === dep && (!isCss || link2.rel === "stylesheet")) {
              return;
            }
          }
        } else if (document.querySelector(`link[href="${dep}"]${cssSelector}`)) {
          return;
        }
        const link = document.createElement("link");
        link.rel = isCss ? "stylesheet" : scriptRel;
        if (!isCss) {
          link.as = "script";
        }
        link.crossOrigin = "";
        link.href = dep;
        if (cspNonce) {
          link.setAttribute("nonce", cspNonce);
        }
        document.head.appendChild(link);
        if (isCss) {
          return new Promise((res, rej) => {
            link.addEventListener("load", res);
            link.addEventListener(
              "error",
              () => rej(new Error(`Unable to preload CSS for ${dep}`))
            );
          });
        }
      })
    );
  }

  function handlePreloadError(err) {
    const e = new Event("vite:preloadError", {
      cancelable: true
    });
    e.payload = err;
    window.dispatchEvent(e);
    if (!e.defaultPrevented) {
      throw err;
    }
  }
  return promise.then((res) => {
    for (const item of res || []) {
      if (item.status !== "rejected") continue;
      handlePreloadError(item.reason);
    }
    return baseModule().catch(handlePreloadError);
  });
};
async function createEditor(container, handlers2) {
  /**
   * Создаёт редактор CodeMirror 6.
   * - languageCompartment: язык Octave (StreamLanguage.define(octave)) подключается
   *   асинхронно после загрузки модуля octave.js (__vitePreload → import("./octave.js")).
   * - themeCompartment: переключение тем (lightTheme / monokaiTheme из themes.js) через
   *   reconfigure без пересоздания редактора; setTheme(name) вызывается из тулбара.
   * - runKeymap: Ctrl-Enter/Cmd-Enter → onRun, Ctrl-s/Cmd-s → onSave.
   * - cursorListener: статус «Ln X, Col Y» в тулбаре; onDocChanged — при изменении
   *   текста (для инвалидации пошагового режима).
   * - stepField: подсветка «планируемого к исполнению блока» (заливка строк +
   *   маркер ▶ на первой строке) через StateField + Decoration.
   * Возвращает { view, setTheme, setValue, getValue, setFilename,
   * setStepRange, clearStepRange }.
   */
  const languageCompartment = new Compartment();
  const themeCompartment = new Compartment();
  const runKeymap = keymap.of([{
      key: "Ctrl-Enter",
      mac: "Cmd-Enter",
      run: () => {
        handlers2.onRun();
        return true;
      }
    },
    {
      key: "Ctrl-s",
      mac: "Cmd-s",
      run: () => {
        handlers2.onSave();
        return true;
      }
    }
  ]);
  const cursorListener = EditorView.updateListener.of((update) => {
    if (update.docChanged && handlers2.onDocChanged) {
      handlers2.onDocChanged();
    }
    if ((update.selectionSet || update.docChanged) && handlers2.onCursor) {
      const pos = update.state.selection.main.head;
      const line = update.state.doc.lineAt(pos);
      handlers2.onCursor(line.number, pos - line.from + 1);
    }
  });
  // Подсветка «планируемого к исполнению блока» (Фаза 1 пошагового режима).
  const setStepRange = StateEffect.define();
  class StepMarkerWidget extends WidgetType {
    toDOM() {
      const span = document.createElement("span");
      span.className = "cm-step-marker";
      span.textContent = "▶";
      return span;
    }
  }
  const stepMarkerWidget = new StepMarkerWidget();
  const buildStepSet = (doc, range) => {
    if (!range) {
      return Decoration.none;
    }
    const fromLine = Math.max(1, range.fromLine);
    const toLine = Math.min(doc.lines, range.toLine);
    const ranges = [];
    for (let ln = fromLine; ln <= toLine; ln++) {
      const line = doc.line(ln);
      ranges.push(
        Decoration.line({
          class: ln === fromLine ? "cm-step-line cm-step-start" : "cm-step-line"
        }).range(line.from)
      );
    }
    if (ranges.length) {
      ranges.push(Decoration.widget({ widget: stepMarkerWidget, side: -1 }).range(doc.line(fromLine).from));
    }
    return Decoration.set(ranges);
  };
  const stepField = StateField.define({
    create: () => Decoration.none,
    update(value, tr) {
      for (const e of tr.effects) {
        if (e.is(setStepRange)) return buildStepSet(tr.state.doc, e.value);
      }
      return value;
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v)
  });
  // Внутристрочная подсветка точного диапазона инструкции (native-шаг, Фаза 2):
  // показывает, какая под-часть составного оператора исполняется прямо сейчас.
  const setStepSpan = StateEffect.define();
  const buildStepSpan = (doc, range) => {
    if (!range) return Decoration.none;
    const { from, to } = range;
    if (typeof from !== "number" || typeof to !== "number" || to <= from) return Decoration.none;
    const max = doc.length;
    const f = Math.max(0, Math.min(from, max));
    const t = Math.max(0, Math.min(to, max));
    if (t <= f) return Decoration.none;
    return Decoration.set([Decoration.mark({ class: "cm-step-span" }).range(f, t)]);
  };
  const stepSpanField = StateField.define({
    create: () => Decoration.none,
    update(value, tr) {
      for (const e of tr.effects) {
        if (e.is(setStepSpan)) return buildStepSpan(tr.state.doc, e.value);
      }
      return value;
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v)
  });
  const state = EditorState.create({
    doc: "",
    extensions: [
      basicSetup,
      languageCompartment.of([]),
      themeCompartment.of([]),
      runKeymap,
      cursorListener,
      stepField,
      stepSpanField,
      indentUnit.of("    ")
    ]
  });
  const view = new EditorView({
    state,
    parent: container
  });
  try {
    const [{
      octave
    }] = await Promise.all([
      __vitePreload(() => import("./octave.js"), true ? [] : void 0, import.meta.url)
    ]);
    view.dispatch({
      effects: languageCompartment.reconfigure(StreamLanguage.define(octave))
    });
  } catch {}
  return {
    view,
    setTheme: (name) => {
      view.dispatch({
        effects: themeCompartment.reconfigure(name === "monokai" ? monokaiTheme : lightTheme)
      });
    },
    setValue: (value) => {
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: value
        }
      });
    },
    getValue: () => view.state.doc.toString(),
    setFilename: (name2) => {
      const el = document.getElementById("editor-filename");
      if (el) {
        el.textContent = name2;
      }
    },
    setStepRange: (fromLine, toLine) => {
      view.dispatch({
        effects: setStepRange.of({ fromLine, toLine })
      });
      if (view.state.doc.lines >= fromLine) {
        view.dispatch({
          effects: EditorView.scrollIntoView(view.state.doc.line(fromLine).from, {
            y: "start"
          })
        });
      }
    },
    setStepSpan: (from, to) => {
      view.dispatch({
        effects: setStepSpan.of({ from, to })
      });
    },
    clearStepSpan: () => {
      view.dispatch({
        effects: setStepSpan.of(null)
      });
    },
    clearStepRange: () => {
      view.dispatch({
        effects: [setStepRange.of(null), setStepSpan.of(null)]
      });
    }
  };
}
class ConsolePane {
  /**
   * Панель консоли/вывода.
   * - write(stream, text): печатает строку вывода с классом по потоку
   *   (stdout/stderr/err/display/warn/meta) в #console-container.
   * - Нижняя строка — REPL-ввод (runmat> ), ведение которой — в main().
   * - Автопрокрутка к низу, если пользователь не отмотал вверх.
   * - clear(): очистка истории при потоке "clear" (движок) или кнопке очистки.
   */
  constructor(el) {
    this.el = el;
    this.inputRow = document.createElement("div");
    this.inputRow.className = "console-input-row";
    this.promptEl = document.createElement("span");
    this.promptEl.className = "console-prompt";
    this.promptEl.textContent = "runmat> ";
    this.inputEl = document.createElement("input");
    this.inputEl.className = "console-input";
    this.inputEl.type = "text";
    this.inputEl.autocomplete = "off";
    this.inputEl.autocapitalize = "off";
    this.inputEl.spellcheck = false;
    this.inputRow.append(this.promptEl, this.inputEl);
    el.appendChild(this.inputRow);
    el.addEventListener("scroll", () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      this.autoScroll = nearBottom;
    });
  }
  autoScroll = true;
  setPrompt(text) {
    this.promptEl.textContent = text;
  }
  setInputDisabled(disabled) {
    this.inputEl.disabled = disabled;
    this.inputEl.placeholder = disabled ? "выполняется…" : "";
  }
  getInputValue() {
    return this.inputEl.value;
  }
  setInputValue(value) {
    this.inputEl.value = value;
  }
  focusInput() {
    this.inputEl.focus();
  }
  echoInput(prompt, text) {
    const div = document.createElement("div");
    div.className = "console-line input";
    const p = document.createElement("span");
    p.className = "console-prompt-inline";
    p.textContent = prompt;
    const t = document.createElement("span");
    t.className = "console-input-echo";
    t.textContent = text;
    div.append(p, t);
    this.append(div);
  }
  write(stream, text) {
    const div = document.createElement("div");
    div.className = `console-line ${stream}`;
    div.textContent = text;
    this.append(div);
  }
  runSeparator() {
    const div = document.createElement("div");
    div.className = "console-run-sep";
    this.append(div);
  }
  clear() {
    const row = this.inputRow;
    if (row) {
      row.remove();
    }
    this.el.textContent = "";
    if (row) {
      this.el.appendChild(row);
    }
    this.autoScroll = true;
  }
  append(node) {
    this.el.insertBefore(node, this.inputRow);
    if (this.autoScroll) {
      this.el.scrollTop = this.el.scrollHeight;
    }
  }
}
const CONSOLE_OPEN_BLOCKS = /* @__PURE__ */ new Set(["if", "for", "while", "switch", "try", "parfor", "spmd", "function"]);
/**
 * Проверка полноты ввода для REPL: считает незакрытые скобки/скобочные группы,
 * открытые блоки (if/for/while/.../end), продолжения "...", и открытые строки.
 * Пока конструкция неполна — REPL ждёт следующей строки (многострочный буфер).
 */
function isInputComplete(text) {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let block = 0;
  let inStr = null;
  let code = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === inStr) {
        if (text[i + 1] === inStr) {
          i++;
        } else {
          inStr = null;
        }
      }
      code += " ";
      continue;
    }
    if (c === "%") {
      break;
    }
    if (c === "'" || c === '"') {
      inStr = c;
      code += " ";
      continue;
    }
    code += c;
  }
  for (const c of code) {
    if (c === "(") {
      paren++;
    } else if (c === ")") {
      paren--;
    } else if (c === "[") {
      bracket++;
    } else if (c === "]") {
      bracket--;
    } else if (c === "{") {
      brace++;
    } else if (c === "}") {
      brace--;
    }
  }
  const wordRe = /[_A-Za-z][_A-Za-z0-9]*/g;
  let m;
  while ((m = wordRe.exec(code))) {
    const w = m[0].toLowerCase();
    if (CONSOLE_OPEN_BLOCKS.has(w)) {
      block++;
    } else if (w === "end" || /^end(function|if|for|while|switch|try|parfor|spmd)$/.test(w)) {
      block--;
    }
  }
  if (block < 0) {
    block = 0;
  }
  const tail = code.trimEnd();
  const dangling = tail.length > 0 && (tail.endsWith("...") || /[=+\-*/^]$/.test(tail));
  return !(paren > 0 || bracket > 0 || brace > 0 || block > 0 || dangling);
}
class VariablesPane {
  /**
   * Панель переменных (таблица имя/класс/размер/резерв).
   * Принимает снапшот workspace из outcome каждого executeRequest.
   * Клик по строке → materialize(name) → детальный просмотр значения (showDetail).
   */
  constructor(bodyEl, detailEl, detailTextEl, closeBtn, onMaterialize) {
    this.bodyEl = bodyEl;
    this.detailEl = detailEl;
    this.detailTextEl = detailTextEl;
    this.closeBtn = closeBtn;
    this.onMaterialize = onMaterialize;
    closeBtn.addEventListener("click", () => this.hideDetail());
  }
  selectedName = null;
  workspace = /* @__PURE__ */ new Map();
  version = -1;
  // FIX (слияние дельт рабочего пространства):
  // Движок отдаёт снапшот как ДЕЛЬТУ: { full:true, values:[полный список] } либо
  // { full:false, values:[только изменённые/добавленные], removals:[удалённые] }.
  // Раньше таблица перерисовывалась только из snapshot.values как из полного списка,
  // поэтому дельта (например, присваивание из консоли после RUN) скрывала остальные
  // переменные — список выглядел очищенным. Ниже: копия в зеркало workspace,
  // при full — полная замена, иначе upsert + применённые removals; рендер — из зеркала.
  update(snapshot) {
    if (snapshot) {
      const ws = this.workspace;
      const values = snapshot.values ?? [];
      if (snapshot.full || snapshot.version > this.version) {
        if (snapshot.full) {
          ws.clear();
        }
        this.version = snapshot.version;
      }
      for (const entry of values) {
        ws.set(entry.name, entry);
      }
      for (const name2 of snapshot.removals ?? []) {
        ws.delete(name2);
      }
    } else {
      this.workspace.clear();
    }
    this.render();
  }
  render() {
    this.bodyEl.textContent = "";
    const values = Array.from(this.workspace.values()).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
    if (values.length === 0) {
      const row = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 4;
      td.className = "vars-empty";
      td.textContent = "(empty)";
      row.appendChild(td);
      this.bodyEl.appendChild(row);
      return;
    }
    for (const entry of values) {
      const tr = document.createElement("tr");
      tr.dataset.name = entry.name;
      if (entry.name === this.selectedName) {
        tr.classList.add("selected");
      }
      tr.addEventListener("click", () => {
        this.selectedName = entry.name;
        for (const r of Array.from(this.bodyEl.querySelectorAll("tr"))) {
          r.classList.toggle("selected", r.dataset.name === entry.name);
        }
        void this.onMaterialize(entry);
      });
      const name2 = document.createElement("td");
      name2.textContent = entry.name;
      const cls = document.createElement("td");
      cls.textContent = entry.className;
      const shape = document.createElement("td");
      shape.textContent = formatShape(entry.shape);
      const res = document.createElement("td");
      res.className = entry.residency === "gpu" ? "gpu" : "cpu";
      res.textContent = entry.residency === "gpu" ? "GPU" : "CPU";
      res.title = entry.residency;
      tr.append(name2, cls, shape, res);
      this.bodyEl.appendChild(tr);
    }
  }
  showDetail(value) {
    this.detailTextEl.textContent = value.valueText || formatDetail(value);
    this.detailEl.classList.remove("hidden");
  }
  hideDetail() {
    this.detailEl.classList.add("hidden");
  }
}

function formatShape(shape) {
  if (!shape || shape.length === 0) {
    return "1x1";
  }
  return shape.map((d) => d === -1 ? "?" : d).join("x");
}

function formatDetail(value) {
  const head = `${value.name}  ${value.className}`;
  if (value.dtype) {
    return `${head}
${value.dtype}  [${value.shape.join("x")}]
${JSON.stringify(value.valueJson ?? null, null, 2)}`;
  }
  return `${head}
[${value.shape.join("x")}]
${JSON.stringify(value.valueJson ?? null, null, 2)}`;
}
class PlotsPane {
  /**
   * Вкладка графиков.
   * - markTouched(handles): запоминает затронутые в последнем запуске фигуры (figuresTouched).
   * - renderAll/renderHandle: рендер PNG-изображения фигуры через wasm (renderFigureImage),
   *   вставка/обновление <img> в карточке .plot-card (figure N).
   * - Размеры рендера подстраиваются под ширину контейнера (ResizeObserver).
   * - При ошибке рендера — карточка с текстом ошибки; пустой набор — подсказка.
   */
  constructor(el) {
    this.el = el;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (w > 0) {
        this.renderWidth = Math.max(200, Math.floor(w * 0.9));
        this.renderHeight = Math.max(240, Math.floor(this.renderWidth * 3 / 5));
      }
    });
    ro.observe(el);
  }
  handles = /* @__PURE__ */ new Set();
  renderWidth = 760;
  renderHeight = 420;
  markTouched(handles) {
    for (const h of handles) {
      this.handles.add(h);
    }
  }
  async renderAll() {
    for (const handle of Array.from(this.handles)) {
      await this.renderHandle(handle);
    }
  }
  async renderHandle(handle) {
    try {
      const bytes = await renderFigureImage({
        handle,
        width: this.renderWidth,
        height: this.renderHeight
      });
      const blob = new Blob([bytes.slice()], {
        type: "image/png"
      });
      const url = URL.createObjectURL(blob);
      let card = this.el.querySelector(`.plot-card[data-handle="${handle}"]`);
      if (!card) {
        card = document.createElement("div");
        card.className = "plot-card";
        card.dataset.handle = String(handle);
        const label = document.createElement("div");
        label.className = "plot-label";
        label.textContent = `Figure ${handle}`;
        card.appendChild(label);
        const img2 = document.createElement("img");
        img2.alt = `Figure ${handle}`;
        card.appendChild(img2);
        this.el.appendChild(card);
      } else {
        const label = card.querySelector(".plot-label");
        if (!label) {
          const l = document.createElement("div");
          l.className = "plot-label";
          l.textContent = `Figure ${handle}`;
          card.prepend(l);
        }
      }
      const img = card.querySelector("img");
      if (img) {
        img.src = url;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      let card = this.el.querySelector(`.plot-card[data-handle="${handle}"]`);
      if (!card) {
        card = document.createElement("div");
        card.className = "plot-card";
        card.dataset.handle = String(handle);
        this.el.appendChild(card);
      }
      const label = document.createElement("div");
      label.className = "plot-label";
      label.textContent = `Figure ${handle} — ${msg}`;
      card.appendChild(label);
    }
  }
  setEmpty() {
    if (this.handles.size === 0) {
      this.el.textContent = "";
      const div = document.createElement("div");
      div.className = "plot-empty";
      div.textContent = "Здесь появятся графики (plot, surf, …).";
      this.el.appendChild(div);
    }
  }
}
class FilesPane {
  /**
   * Дерево файлов виртуальной ФС провайдера.
   * - setProvider(provider) → refresh(): корень "/", вложенные папки подгружаются лениво
   *   при раскрытии (▸/▾).
   * - Клик по .m-файлу → onOpenFile(path) → openFile() (загрузка в редактор).
   * - Выделение активного файла (.selected) синхронизируется через select().
   */
  constructor(rootEl, cb) {
    this.rootEl = rootEl;
    this.cb = cb;
  }
  provider = null;
  container = null;
  selectedPath = null;
  setProvider(provider) {
    this.provider = provider;
    void this.refresh();
  }
  select(path) {
    this.selectedPath = path;
    for (const row of Array.from(this.rootEl.querySelectorAll(".fs-row"))) {
      row.classList.toggle("selected", row.dataset.path === path);
    }
  }
  async refresh() {
    this.rootEl.textContent = "";
    if (!this.provider) {
      const div = document.createElement("div");
      div.className = "fs-row";
      div.textContent = "(нет файлов)";
      this.rootEl.appendChild(div);
      return;
    }
    const children = await this.listDir("/");
    for (const entry of children) {
      this.rootEl.appendChild(this.buildNode(entry));
    }
    if (children.length === 0) {
      const div = document.createElement("div");
      div.className = "fs-row";
      div.textContent = "(пусто)";
      this.rootEl.appendChild(div);
    }
  }
  async listDir(path) {
    if (!this.provider) {
      return [];
    }
    let entries;
    try {
      entries = await this.provider.readDir(path);
    } catch {
      return [];
    }
    return entries.map((e) => ({
      path: e.path,
      name: e.fileName,
      kind: e.fileType === "dir" || e.fileType === "directory" ? "dir" : "file",
      isM: e.fileName.toLowerCase().endsWith(".m")
    }));
  }
  buildNode(entry) {
    const isDir = entry.kind === "dir";
    const row = document.createElement("div");
    row.className = `fs-row ${isDir ? "dir" : "file"}${entry.isM ? " m" : ""}`;
    row.dataset.path = entry.path;
    const caret = document.createElement("span");
    caret.className = "caret";
    caret.textContent = isDir ? "▸" : "";
    row.appendChild(caret);
    const icon = document.createElement("span");
    icon.className = "icon";
    icon.textContent = isDir ? "📁" : entry.isM ? "ƒ" : "·";
    row.appendChild(icon);
    const name2 = document.createElement("span");
    name2.className = "name";
    name2.textContent = entry.name;
    name2.title = entry.path;
    row.appendChild(name2);
    const children = document.createElement("div");
    children.className = "fs-children";
    children.style.display = "none";
    const toggle = async () => {
      if (children.style.display === "none") {
        caret.textContent = "▾";
        children.style.display = "block";
        if (children.childElementCount === 0) {
          const kids = await this.listDir(entry.path);
          for (const kid of kids) {
            children.appendChild(this.buildNode(kid));
          }
          if (kids.length === 0) {
            const empty2 = document.createElement("div");
            empty2.className = "fs-row";
            empty2.textContent = "(пусто)";
            children.appendChild(empty2);
          }
        }
      } else {
        caret.textContent = "▸";
        children.style.display = "none";
      }
    };
    if (isDir) {
      caret.addEventListener("click", (e) => {
        e.stopPropagation();
        void toggle();
      });
      row.addEventListener("click", () => void toggle());
    } else {
      row.addEventListener("click", () => {
        this.selectedPath = entry.path;
        for (const r of Array.from(this.rootEl.querySelectorAll(".fs-row"))) {
          r.classList.toggle("selected", r.dataset.path === entry.path);
        }
        this.cb.onOpenFile(entry.path);
      });
    }
    const wrap = document.createElement("div");
    wrap.appendChild(row);
    wrap.appendChild(children);
    return wrap;
  }
}
class FsaFilesystemProvider {
  /**
   * Провайдер ФС на базе File System Access API (Chromium).
   * Реализует контракт, ожидаемый движком от fsProvider (readFile/writeFile/readDir/
   * metadata/createDir/removeFile/rename...). Используется и как источник дерева файлов,
   * и как хранилище для файловых операций скриптов (save/load/import).
   * create() открывает диалог выбора папки (readwrite); null, если API недоступен.
   */
  constructor(root) {
    this.root = root;
  }
  static async create() {
    const pick = window.showDirectoryPicker;
    if (!pick) {
      return null;
    }
    const handle = await pick({
      mode: "readwrite"
    });
    return new FsaFilesystemProvider(handle);
  }
  get rootName() {
    return this.root.name;
  }
  split(path) {
    return path.split("/").filter((s) => s.length > 0);
  }
  join(...parts) {
    return "/" + parts.join("/");
  }
  async dirForPath(path) {
    const parts = this.split(path);
    parts.pop();
    let dir = this.root;
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, {
        create: false
      });
    }
    return dir;
  }
  async handleFor(path) {
    const parts = this.split(path);
    const name2 = parts.pop();
    if (!name2) {
      throw new Error(`invalid path: ${path}`);
    }
    const dir = await this.dirForPath(path);
    return dir.getFileHandle(name2, {
      create: false
    });
  }
  async readFile(path) {
    const file = await (await this.handleFor(path)).getFile();
    return new Uint8Array(await file.arrayBuffer());
  }
  async writeFile(path, data) {
    const parts = this.split(path);
    const name2 = parts.pop();
    if (!name2) {
      throw new Error(`invalid path: ${path}`);
    }
    const dir = await this.dirForPath(path);
    const handle = await dir.getFileHandle(name2, {
      create: true
    });
    const writable = await handle.createWritable();
    const u8 = data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer);
    await writable.write(u8.slice());
    await writable.close();
  }
  async removeFile(path) {
    const parts = this.split(path);
    const name2 = parts.pop();
    if (!name2) {
      throw new Error(`invalid path: ${path}`);
    }
    const dir = await this.dirForPath(path);
    await dir.removeEntry(name2);
  }
  async metadata(path) {
    const parts = this.split(path);
    const name2 = parts.pop();
    if (!name2) {
      return {
        fileType: "dir",
        len: 0
      };
    }
    const dir = await this.dirForPath(path);
    try {
      const fh = await dir.getFileHandle(name2);
      const file = await fh.getFile();
      return {
        fileType: "file",
        len: file.size,
        modified: file.lastModified
      };
    } catch {
      await dir.getDirectoryHandle(name2);
      return {
        fileType: "dir",
        len: 0
      };
    }
  }
  async readDir(path) {
    const dir = await this.dirForPath(path);
    const out = [];
    const prefix = this.join(...this.split(path));
    const entries = dir.entries();
    for await (const [name2, handle] of entries) {
      out.push({
        path: prefix === "/" ? this.join(name2) : this.join(prefix, name2),
        fileName: name2,
        fileType: handle.kind === "directory" ? "dir" : "file"
      });
    }
    out.sort((a, b) => {
      const ad = a.fileType === "dir" ? 0 : 1;
      const bd = b.fileType === "dir" ? 0 : 1;
      return ad - bd || a.fileName.localeCompare(b.fileName);
    });
    return out;
  }
  async createDir(path) {
    await this.dirForPath(path).then(
      (dir) => dir.getDirectoryHandle(this.split(path).pop(), {
        create: true
      })
    ).then(() => void 0);
  }
  async createDirAll(path) {
    let cur2 = this.root;
    for (const part of this.split(path)) {
      cur2 = await cur2.getDirectoryHandle(part, {
        create: true
      });
    }
  }
  async removeDir(path) {
    const parts = this.split(path);
    const name2 = parts.pop();
    if (!name2) {
      throw new Error("cannot remove root");
    }
    const dir = await this.dirForPath(path);
    await dir.removeEntry(name2, {
      recursive: false
    });
  }
  async removeDirAll(path) {
    const parts = this.split(path);
    const name2 = parts.pop();
    if (!name2) {
      throw new Error("cannot remove root");
    }
    const dir = await this.dirForPath(path);
    await dir.removeEntry(name2, {
      recursive: true
    });
  }
  async rename(from, to) {
    const data = await this.readFile(from);
    await this.writeFile(to, data);
    try {
      await this.removeFile(from);
    } catch {}
  }
}
const $ = (id) => document.getElementById(id);
async function main() {
  /**
   * Точка входа приложения. Создаёт панели и связывает их с wasm-сессией:
   * - ConsolePane, PlotsPane, FilesPane — UI-панели.
   * - provider = createDefaultFsProvider() — виртуальная ФС по умолчанию
   *   (может быть заменена на FsaFilesystemProvider через «Открыть папку»).
   * - RunSession с колбэками: onStdout→консоль, onBusy→индикатор/блокировка ввода,
   *   onExecuted→обработка результата, onError/onReady.
   * - REPL-ввод консоли: история (↑/↓), многострочный буфер (isInputComplete),
   *   отправка через session.run({kind:"text", name:"<console>", ...}).
   * - onExecuted(): вывод displayEvents/warnings/error, мета (время·JIT),
   *   обновление VariablesPane (дельта workspace) и PlotsPane (figuresTouched).
   * - Редактор: createEditor + runEditor()/saveCurrent()/openFile()/newFile().
   * - Тулбар: Run, Clear, New, Save, папка, импорт, экспорт, тумблеры консоли/графиков,
   *   выбор темы; ресайзер колонки переменных (--vars-w).
   * - Финал: seedDemo() (демо-файлы при первом запуске), session.init(), открытие /hello.m.
   */
  const consolePane = new ConsolePane($("console-container"));
  const plotsPane = new PlotsPane($("plots-container"));
  const filesPane = new FilesPane($("files-tree"), {
    onOpenFile: (path) => {
      void openFile(path);
    }
  });
  let currentPath = null;
  let provider = await createDefaultFsProvider();
  let gpuLabel = "GPU: …";

  const session = new RunSession({
    onStdout: (entry) => {
      if (entry.stream === "clear") {
        consolePane.clear();
        return;
      }
      consolePane.write(entry.stream, entry.text);
    },
    onBusy: (busy) => {
      $("busy-indicator").classList.toggle("hidden", !busy);
      $("btn-run").disabled = busy;
      consoleBusy = busy;
      consolePane.setInputDisabled(busy);
      updateStepButtons();
      if (!busy) {
        consolePane.focusInput();
      }
    },
    onExecuted: (result) => onExecuted(result),
    onStepRequest: (req) => nativeStepRequest(req),
    onError: (message) => {
      consolePane.write("err", message);
    },
    onReady: (gpu) => {
      gpuLabel = gpu.active ? "GPU: active" : gpu.error ? `GPU: CPU fallback (${gpu.error})` : "GPU: CPU fallback";
      const jitToggle = $("jit-toggle");
      const jitSupported = !!gpu.jitSupported;
      if (jitSupported) {
        const on = loadJit();
        jitToggle.disabled = false;
        jitToggle.checked = on;
        gpuLabel += ` · JIT: ${on ? "on" : "off"}`;
      } else {
        jitToggle.disabled = true;
        jitToggle.checked = false;
        gpuLabel += " · JIT: unavailable";
      }
      $("gpu-status").textContent = gpuLabel;
      $("gpu-status").title = gpuLabel;
    }
  });

  let consoleBusy = false;
  const consoleHistory = [];
  let consoleHistIndex = 0;
  let consoleDraft = "";
  let consoleBuffer = "";
  let consoleBufferActive = false;
  const consoleInput = consolePane.inputEl;

  function consoleSubmit() {
    if (consoleBusy) {
      consolePane.write("meta", "…выполняется предыдущая команда");
      return;
    }
    const raw = consoleInput.value;
    consoleInput.value = "";
    const line = raw.trim();
    if (!line) {
      if (consoleBufferActive) {
        consolePane.echoInput("...> ", "");
      }
      return;
    }
    const continuing = consoleBufferActive;
    const candidate = continuing ? consoleBuffer + "\n" + line : line;
    consolePane.echoInput(continuing ? "...> " : "runmat> ", line);
    if (!isInputComplete(candidate)) {
      consoleBuffer = candidate;
      consoleBufferActive = true;
      consolePane.setPrompt("...> ");
    } else {
      consoleBuffer = "";
      consoleBufferActive = false;
      consolePane.setPrompt("runmat> ");
      if (consoleHistory[consoleHistory.length - 1] !== candidate) {
        consoleHistory.push(candidate);
      }
      consoleHistIndex = consoleHistory.length;
      consolePane.runSeparator();
      void session.run({ kind: "text", name: "<console>", text: candidate });
    }
  }

  function consoleCursorToEnd() {
    const len = consoleInput.value.length;
    consoleInput.setSelectionRange(len, len);
  }

  consoleInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      consoleSubmit();
    } else if (e.key === "ArrowUp") {
      if (consoleHistory.length === 0 || consoleHistIndex === 0) {
        return;
      }
      e.preventDefault();
      if (consoleHistIndex === consoleHistory.length) {
        consoleDraft = consoleInput.value;
      }
      consoleHistIndex = Math.max(0, consoleHistIndex - 1);
      consoleInput.value = consoleHistory[consoleHistIndex] ?? "";
      consoleCursorToEnd();
    } else if (e.key === "ArrowDown") {
      if (consoleHistIndex === consoleHistory.length) {
        return;
      }
      e.preventDefault();
      consoleHistIndex++;
      if (consoleHistIndex === consoleHistory.length) {
        consoleInput.value = consoleDraft;
      } else {
        consoleInput.value = consoleHistory[consoleHistIndex] ?? "";
      }
      consoleCursorToEnd();
    } else if (e.key === "Escape") {
      if (consoleBufferActive) {
        e.preventDefault();
        consoleBuffer = "";
        consoleBufferActive = false;
        consolePane.setPrompt("runmat> ");
        consoleInput.value = "";
        consolePane.write("meta", "… ввод отменён");
      }
    }
  });

  function onExecuted(result) {
    for (const ev of result.displayEvents ?? []) {
      consolePane.write("display", ev.valueText ?? "");
    }
    for (const w of result.warnings ?? []) {
      consolePane.write("warn", `Warning: ${w.message}`);
    }
    if (result.error) {
      consolePane.write("err", result.error.diagnostic ?? result.error.message);
      if (stepMode && stepEngine === "native") {
        if (nativeLastMarker) {
          editor.setStepRange(nativeLastMarker.lineFrom, nativeLastMarker.lineTo);
        }
        stopStep(true);
      } else if (stepMode && stepStmts && stepIndex > 0) {
        const failed = stepStmts[stepIndex - 1];
        editor.setStepRange(failed.lineFrom, failed.lineTo);
        stopStep(true);
      }
    } else if (stepMode && stepEngine === "native" && nativeActive) {
      stopStep();
    }
    const meta2 = `— ${result.executionTimeMs.toFixed(1)} ms${result.usedJit ? " · JIT" : ""}`;
    consolePane.write("meta", meta2);
    variablesPane.update(result.workspace);
    plotsPane.markTouched(result.figuresTouched ?? []);
    plotsPane.setEmpty();
    void plotsPane.renderAll();
  }
  const variablesPane = new VariablesPane(
    $("vars-body"),
    $("vars-detail"),
    $("vars-detail-text"),
    $("vars-detail-close"),
    async (entry) => {
      try {
        const value = await session.materialize({
          name: entry.name,
          previewToken: entry.previewToken
        }, {
          limit: 1e4
        });
        if (value) {
          variablesPane.showDetail(value);
        }
      } catch (e) {
        consolePane.write("err", `Не удалось показать ${entry.name}: ${describeError(e)}`);
      }
    }
  );
  const editor = await createEditor($("editor-container"), {
    onRun: () => {
      void runEditor();
    },
    onSave: () => {
      void saveCurrent();
    },
    onCursor: (line, col) => {
      $("editor-cursor").textContent = `Ln ${line}, Col ${col}`;
    },
    onDocChanged: () => {
      if (stepMode) {
        stopStep();
      }
    }
  });
  async function runEditor() {
    const text = editor.getValue().trim();
    if (!text) {
      return;
    }
    if (stepMode && stepEngine === "native") {
      nativeStepNext();
      return;
    }
    if (stepMode && stepStmts) {
      stepRun();
      return;
    }
    consolePane.runSeparator();
    consolePane.write("meta", `» ${currentPath ?? "<editor>"}`);
    const source = {
      kind: "text",
      name: currentPath ?? "<editor>",
      text
    };
    await session.run(source);
  }
  // --- Пошаговый режим -----------------------------------------------------
  // UI-движок (Фаза 1): источник разбивается на верхнеуровневые операторы
  // (stepper.js); каждый шаг отправляет один оператор в executeRequest. Переменные
  // сохраняются сессией между вызовами, поэтому шаги «видят» предыдущие результаты.
  // Native-движок (Фаза 2): один executeRequest({ stepMode: true }); интерпретатор
  // сам останавливается на границах операторов (в т.ч. внутри циклов/функций) и
  // вызывает JS-хендлер (setStepHandler), который ждёт решения пользователя.
  let stepMode = false;
  let stepStmts = null;
  let stepIndex = 0;
  let stepEngine = "ui";
  let nativeActive = false;
  let nativePaused = false;
  let nativeDecision = null;
  let nativeAutoDecision = null;
  let nativeRunSource = null;
  let nativeLastMarker = null;

  function offsetToLine(text, offset) {
    let line = 1;
    let bytes = 0;
    const end = Math.max(0, Math.min(offset, utf8ByteLength(text)));
    for (let i = 0; i < text.length && bytes < end; i++) {
      const code = text.codePointAt(i);
      const cpBytes = code > 0xffff ? 4 : code > 0x7ff ? 3 : code > 0x7f ? 2 : 1;
      if (bytes + cpBytes > end) {
        break;
      }
      bytes += cpBytes;
      if (code === 10) {
        line++;
      }
    }
    return line;
  }

  function utf8ByteLength(text) {
    let len = 0;
    for (const ch of text) {
      len += ch.codePointAt(0) > 0xffff ? 4 : ch.codePointAt(0) > 0x7ff ? 3 : ch.codePointAt(0) > 0x7f ? 2 : 1;
    }
    return len;
  }

  // Байтовый offset (UTF-8) из движка → позиция в документе редактора
  // (счётчик символов/code-unit, UTF-16), чтобы корректно подсвечивать
  // внутристрочный диапазон инструкции.
  function byteOffsetToCharPos(text, byteOffset) {
    const end = Math.max(0, Math.min(byteOffset, utf8ByteLength(text)));
    let bytes = 0;
    let pos = 0;
    for (let i = 0; i < text.length && bytes < end; i++) {
      const cu = text.charCodeAt(i);
      let cpBytes;
      if (cu >= 0xD800 && cu <= 0xDBFF) {
        cpBytes = 4;
        i++;
        pos += 2;
      } else if (cu < 0x80) {
        cpBytes = 1;
        pos += 1;
      } else if (cu < 0x800) {
        cpBytes = 2;
        pos += 1;
      } else {
        cpBytes = 3;
        pos += 1;
      }
      bytes += cpBytes;
    }
    return pos;
  }

  function positionNativeMarker(offset, end) {
    const text = nativeRunSource ?? editor.getValue();
    const line = offsetToLine(text, offset);
    const clamped = Math.max(1, Math.min(line, editorLineCount()));
    editor.setStepRange(clamped, clamped);
    nativeLastMarker = { lineFrom: clamped, lineTo: clamped };
    // Внутристрочная подсветка точного диапазона инструкции: составные операторы
    // (напр. disp(["det = ", num2str(d)]) в linalg.m) компилируются в несколько
    // VM-инструкций на одной строке — без неё шаги выглядели как зависание.
    if (typeof end === "number" && end > offset) {
      const from = byteOffsetToCharPos(text, offset);
      const to = byteOffsetToCharPos(text, end);
      if (to > from) {
        editor.setStepSpan(from, to);
        return;
      }
    }
    editor.clearStepSpan();
  }

  function editorLineCount() {
    try {
      return editor.view.state.doc.lines;
    } catch (e) {
      return 1;
    }
  }

  function loadSteps() {
    const stmts = splitStatements(editor.getValue());
    if (!stmts.length) {
      consolePane.write("meta", "Нет операторов для пошагового исполнения.");
      stopStep();
      return false;
    }
    if (isFunctionFile(stmts)) {
      consolePane.write("meta", "Файл с функцией верхнего уровня: пошаговый режим недоступен — обычный запуск.");
      stopStep();
      return false;
    }
    stepStmts = stmts;
    stepIndex = 0;
    editor.setStepRange(stmts[0].lineFrom, stmts[0].lineTo);
    updateStepButtons();
    return true;
  }

  function loadNativeSteps() {
    const text = editor.getValue().trim();
    if (!text) {
      consolePane.write("meta", "Нет кода для пошагового исполнения.");
      stopStep();
      return false;
    }
    if (!session.supportsNativeStep()) {
      consolePane.write("meta", "Native-шаг недоступен: glue не содержит setStepHandler (нужна новая сборка wasm).");
      $("step-engine").value = "ui";
      return false;
    }
    const stmts = splitStatements(editor.getValue());
    if (!stmts.length) {
      consolePane.write("meta", "Нет операторов для пошагового исполнения.");
      stopStep();
      return false;
    }
    if (isFunctionFile(stmts)) {
      consolePane.write("meta", "Файл с функцией верхнего уровня: пошаговый режим недоступен — обычный запуск.");
      stopStep();
      return false;
    }
    stepStmts = stmts;
    stepIndex = 0;
    nativeActive = true;
    nativePaused = false;
    nativeDecision = null;
    nativeAutoDecision = null;
    nativeRunSource = editor.getValue();
    editor.setStepRange(stmts[0].lineFrom, stmts[0].lineTo);
    nativeLastMarker = { lineFrom: stmts[0].lineFrom, lineTo: stmts[0].lineTo };
    updateStepButtons();
    return true;
  }

  function nativeStepRequest(req) {
    return new Promise((resolve) => {
      if (nativeAutoDecision) {
        const auto = nativeAutoDecision;
        nativeAutoDecision = null;
        resolve(auto);
        return;
      }
      if (!stepMode || stepEngine !== "native" || !nativeActive) {
        resolve("continue");
        return;
      }
      positionNativeMarker(req.offset, req.end);
      // Native step mode runs the whole program inside a single
      // `executeRequest`, so the variables panel only receives the workspace
      // delta in the final outcome (at the very end). Refresh it here on every
      // pause: the preceding statement(s) have already executed, so the live
      // workspace snapshot reflects their results.
      refreshNativeStepVariables();
      nativePaused = true;
      nativeDecision = { resolve };
      updateStepButtons();
    });
  }

  async function refreshNativeStepVariables() {
    try {
      const snap = await session.workspaceSnapshot();
      if (snap) {
        variablesPane.update(snap);
      }
    } catch (_) {
      /* workspace snapshot unavailable mid-step */
    }
  }

  function nativeRunSourceObj() {
    return {
      kind: "text",
      name: currentPath ?? "<editor>",
      text: nativeRunSource ?? editor.getValue()
    };
  }

  function nativeStepNext() {
    if (!nativeActive || (consoleBusy && !nativePaused)) {
      return;
    }
    if (nativePaused) {
      const d = nativeDecision;
      nativePaused = false;
      nativeDecision = null;
      d.resolve("next");
      updateStepButtons();
      return;
    }
    nativeAutoDecision = "next";
    consolePane.runSeparator();
    consolePane.write("meta", `» [шаг (native)] ${currentPath ?? "<editor>"}`);
    void session.runStep(nativeRunSourceObj());
  }

  function nativeStepContinue() {
    if (!nativeActive) {
      return;
    }
    if (nativePaused) {
      const d = nativeDecision;
      nativePaused = false;
      nativeDecision = null;
      nativeActive = false;
      d.resolve("continue");
      stopStep();
      return;
    }
    nativeAutoDecision = "continue";
    consolePane.runSeparator();
    consolePane.write("meta", `» [продолжение (native)] ${currentPath ?? "<editor>"}`);
    void session.runStep(nativeRunSourceObj());
    nativeActive = false;
    stopStep();
  }

  function nativeStepStop() {
    if (nativePaused && nativeDecision) {
      const d = nativeDecision;
      nativePaused = false;
      nativeDecision = null;
      d.resolve("stop");
    }
    nativeActive = false;
    stopStep();
  }

  function stepRun() {
    if (!stepMode || !stepStmts || consoleBusy) {
      return;
    }
    if (stepIndex >= stepStmts.length) {
      stopStep();
      return;
    }
    const stmt = stepStmts[stepIndex++];
    consolePane.runSeparator();
    consolePane.write("meta", `» [шаг ${stepIndex}/${stepStmts.length}] ${currentPath ?? "<editor>"}`);
    void session.run({
      kind: "text",
      name: currentPath ?? "<editor>",
      text: stmt.text
    });
    // Маркер указывает на следующий планируемый оператор (после последнего — снимается).
    const next = stepStmts[stepIndex];
    if (next) {
      editor.setStepRange(next.lineFrom, next.lineTo);
    } else {
      editor.clearStepRange();
    }
    updateStepButtons();
  }

  function stepContinue() {
    if (!stepMode || !stepStmts || consoleBusy) {
      return;
    }
    if (stepIndex >= stepStmts.length) {
      stopStep();
      return;
    }
    const rest = joinFrom(stepStmts, stepIndex);
    consolePane.runSeparator();
    consolePane.write("meta", `» [продолжение: ${stepStmts.length - stepIndex} операторов] ${currentPath ?? "<editor>"}`);
    void session.run({
      kind: "text",
      name: currentPath ?? "<editor>",
      text: rest
    });
    stopStep();
  }

  function stopStep(keepRange) {
    stepMode = false;
    stepStmts = null;
    stepIndex = 0;
    nativeActive = false;
    nativePaused = false;
    nativeDecision = null;
    nativeAutoDecision = null;
    nativeRunSource = null;
    nativeLastMarker = null;
    if (!keepRange) {
      editor.clearStepRange();
    }
    updateStepButtons();
    $("btn-step").classList.remove("on");
  }

  function updateStepButtons() {
    const uiActive = stepMode && !!stepStmts && stepEngine === "ui";
    const nativeInteractive = nativeActive && (nativePaused || !consoleBusy);
    if (stepEngine === "native") {
      $("btn-step-next").disabled = !nativeInteractive;
      $("btn-step-continue").disabled = !nativeInteractive;
      $("btn-step-stop").disabled = !(nativeActive || stepMode);
    } else {
      const hasNext = uiActive && stepIndex < stepStmts.length;
      $("btn-step-next").disabled = !hasNext || consoleBusy;
      $("btn-step-continue").disabled = !hasNext || consoleBusy;
      $("btn-step-stop").disabled = !uiActive;
    }
  }
  async function saveCurrent() {
    const text = editor.getValue();
    const path = currentPath ?? "/untitled.m";
    try {
      await provider.writeFile(path, new TextEncoder().encode(text));
      consolePane.write("meta", `✓ saved ${path}`);
    } catch (e) {
      consolePane.write("err", `Не удалось сохранить ${path}: ${describeError(e)}`);
    }
  }
  async function openFile(path) {
    try {
      const data = await provider.readFile(path);
      const text = new TextDecoder().decode(data instanceof ArrayBuffer ? data : new Uint8Array(data));
      editor.setValue(text);
      currentPath = path;
      editor.setFilename(path);
      filesPane.select(path);
    } catch (e) {
      consolePane.write("err", `Не удалось открыть ${path}: ${describeError(e)}`);
    }
  }
  async function newFile() {
    const name2 = window.prompt("Имя нового файла (напр. script.m):", "script.m");
    if (!name2) {
      return;
    }
    const path = "/" + name2.replace(/^\/+/, "");
    try {
      await provider.writeFile(path, new TextEncoder().encode(""));
      await filesPane.refresh();
      await openFile(path);
    } catch (e) {
      consolePane.write("err", `Не удалось создать ${path}: ${describeError(e)}`);
    }
  }
  async function openFolder() {
    try {
      const fsa = await FsaFilesystemProvider.create();
      if (!fsa) {
        consolePane.write("warn", "File System Access API недоступен в этом браузере. Откройте в Chrome/Edge.");
        return;
      }
      provider = fsa;
      await session.setFsProvider(provider);
      filesPane.setProvider(provider);
      $("editor-filename").textContent = "untitled.m";
      document.title = `RunMat Web — ${fsa.rootName}`;
      consolePane.write("meta", `Открыта папка: ${fsa.rootName}`);
    } catch (e) {
      consolePane.write("err", `Не удалось открыть папку: ${describeError(e)}`);
    }
  }

  function importFiles() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".m,.txt,.dat,.csv,.mat";
    input.multiple = true;
    input.addEventListener("change", async () => {
      if (!input.files) {
        return;
      }
      for (const file of Array.from(input.files)) {
        try {
          const data = new Uint8Array(await file.arrayBuffer());
          await provider.writeFile("/" + file.name, data);
        } catch (e) {
          consolePane.write("err", `Не удалось импортировать ${file.name}: ${describeError(e)}`);
        }
      }
      await filesPane.refresh();
      consolePane.write("meta", `Импортировано файлов: ${input.files.length}`);
    });
    input.click();
  }

  function exportCurrent() {
    const text = editor.getValue();
    const name2 = (currentPath ?? "untitled.m").split("/").pop() || "untitled.m";
    const blob = new Blob([text], {
      type: "text/plain;charset=utf-8"
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name2;
    a.click();
    URL.revokeObjectURL(url);
  }
  $("btn-run").addEventListener("click", () => void runEditor());
  $("btn-step").addEventListener("click", () => {
    if (consoleBusy) {
      return;
    }
    stepEngine = $("step-engine").value;
    stepMode = !stepMode;
    if (stepMode) {
      const ok = stepEngine === "native" ? loadNativeSteps() : loadSteps();
      if (!ok) {
        return;
      }
    } else {
      stopStep();
      return;
    }
    $("btn-step").classList.add("on");
    updateStepButtons();
  });
  $("step-engine").addEventListener("change", () => {
    if (stepMode) {
      stopStep();
    }
  });
  $("btn-step-next").addEventListener("click", () => {
    if (stepEngine === "native") {
      nativeStepNext();
    } else {
      stepRun();
    }
  });
  $("btn-step-continue").addEventListener("click", () => {
    if (stepEngine === "native") {
      nativeStepContinue();
    } else {
      stepContinue();
    }
  });
  $("btn-step-stop").addEventListener("click", () => {
    if (stepEngine === "native") {
      nativeStepStop();
    } else {
      stopStep();
    }
  });
  $("btn-clear").addEventListener("click", () => {
    session.clearWorkspace();
    variablesPane.update(void 0);
    variablesPane.hideDetail();
    consolePane.write("meta", "workspace cleared");
  });
  $("btn-new").addEventListener("click", () => void newFile());
  $("btn-save").addEventListener("click", () => void saveCurrent());
  $("btn-open-folder").addEventListener("click", () => void openFolder());
  $("btn-import").addEventListener("click", importFiles);
  $("btn-export").addEventListener("click", exportCurrent);
  $("btn-toggle-console").addEventListener("click", () => {
    const pane = $("bottom-pane");
    const hidden = pane.classList.toggle("hidden");
    $("btn-toggle-console").classList.toggle("on", !hidden);
    $("btn-toggle-console").classList.toggle("off", hidden);
  });
  $("btn-toggle-plots").addEventListener("click", () => {
    const varsPanel = $("vars-panel");
    const hidden = varsPanel.classList.toggle("plots-hidden");
    $("btn-toggle-plots").classList.toggle("on", !hidden);
    $("btn-toggle-plots").classList.toggle("off", hidden);
  });
  $("theme-select").addEventListener("change", (e) => {
    editor.setTheme(e.target.value);
  });
  $("jit-toggle").addEventListener("change", (e) => {
    const on = e.target.checked;
    saveJit(on);
    consolePane.write(
      "meta",
      `JIT ${on ? "включён" : "выключен"}. Изменение вступит в силу после перезапуска сессии (обновите страницу).`
    );
  });
  const appEl = $("app");
  const resizeHandle = $("resize-handle");
  let resizing = null;
  resizeHandle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) {
      return;
    }
    e.preventDefault();
    const current = parseFloat(appEl.style.getPropertyValue("--vars-w")) || 300;
    resizing = { startX: e.clientX, startW: current };
    document.body.classList.add("resizing-col");
    resizeHandle.setPointerCapture(e.pointerId);
  });
  resizeHandle.addEventListener("pointermove", (e) => {
    if (!resizing) {
      return;
    }
    const w = resizing.startW + (resizing.startX - e.clientX);
    const max = Math.floor(window.innerWidth * 0.6);
    appEl.style.setProperty("--vars-w", Math.max(220, Math.min(w, max)) + "px");
  });
  const finishResize = () => {
    if (resizing) {
      resizing = null;
      document.body.classList.remove("resizing-col");
    }
  };
  resizeHandle.addEventListener("pointerup", finishResize);
  resizeHandle.addEventListener("pointercancel", finishResize);
  await seedDemo(provider, consolePane);
  filesPane.setProvider(provider);
  await session.init(provider);
  await openFile("/hello.m").catch(() => {});
}
const DEMO_FILES = {
  /**
   * Демо-проект, создаваемый при первом запуске (когда в ФС ещё нет /hello.m).
   * Примечание: linalg.m намеренно содержит падающую строку B = inv(A) —
   * magic(4) вырожденна, движок вернёт ошибку «singular» и НЕ закоммитит переменные
   * (см. CONTEXT.md: переменные фиксируются в workspace только при успехе).
   */
  "/hello.m": `% Приветствие
x = linspace(0, 2*pi, 200);
y = sin(x);
disp("Hello from RunMat Web!");
plot(x, y);
title("Hello from RunMat Web");`,
  "/linalg.m": `A = magic(4);
disp("magic(4) =");
disp(A);
d = det(A);
e = eig(A);
disp(["det = ", num2str(d)]);
B = inv(A);
disp("A*inv(A) ~ I");
disp(B * A);`,
  "/plots_demo.m": `t = linspace(0, 2*pi, 300);
figure(1);
subplot(2, 1, 1);
plot(t, sin(t), 'r-', t, cos(t), 'b--');
legend('sin', 'cos');
xlabel('t'); ylabel('y'); title('Тригонометрия'); grid on;

figure(2);
subplot(2, 1, 2);
y = sin(t) .* exp(-t / 3);
plot(t, y, 'g.-');
xlabel('t'); ylabel('y');
title('Затухающая синусоида'); grid on;`
};
async function seedDemo(provider, consolePane) {
  try {
    await provider.metadata("/hello.m");
    return;
  } catch {}
  for (const [path, text] of Object.entries(DEMO_FILES)) {
    try {
      await provider.writeFile(path, new TextEncoder().encode(text));
    } catch (e) {
      consolePane.write("err", `Не удалось создать демо ${path}: ${describeError(e)}`);
    }
  }
  consolePane.write("meta", "Демо-проект создан (hello.m, linalg.m, plots_demo.m).");
}
/* Запуск приложения при загрузке модуля */
void main();
