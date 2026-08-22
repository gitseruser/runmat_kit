/**
 * Темы редактора (CodeMirror 6).
 * - monokaiTheme: массив расширений = EditorView.theme({...}) (цвета тёмной темы) +
 *   EditorView.darkTheme.of(true) (сигнализирует CM о тёмной теме) +
 *   syntaxHighlighting(HighlightStyle.define([...])) (раскраска токенов по тегам lezer).
 * - lightTheme: пустой массив — используется базовый light-вид редактора.
 * Переключение выполняется в index.js через themeCompartment.reconfigure(...).
 */
import {
  EditorView,
  HighlightStyle,
  tags,
  syntaxHighlighting
} from "./editor-lib.js";

const monokaiHighlighter = HighlightStyle.define([
  { tag: tags.keyword, color: "#f92672" },
  { tag: [tags.name, tags.deleted, tags.character, tags.propertyName, tags.macroName], color: "#f92672" },
  { tag: [tags.function(tags.variableName)], color: "#a6e22e" },
  { tag: [tags.definition(tags.typeName), tags.typeName], color: "#66d9ef" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "#ae81ff" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "#e6db74" },
  { tag: [tags.comment, tags.meta], color: "#75715e" },
  { tag: tags.operator, color: "#f8f8f2" },
  { tag: [tags.definition(tags.variableName), tags.variableName], color: "#f8f8f2" },
  { tag: [tags.bracket, tags.punctuation], color: "#f8f8f2" },
  { tag: [tags.heading, tags.link], color: "#f92672" }
]);

export const monokaiTheme = [
  EditorView.theme({
    "&": {
      backgroundColor: "#272822",
      color: "#f8f8f2"
    },
    ".cm-content": {
      caretColor: "#f8f8f0"
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "#f8f8f0"
    },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "#49483e"
    },
    ".cm-gutters": {
      backgroundColor: "#272822",
      color: "#90908a",
      border: "none"
    },
    ".cm-activeLineGutter": {
      backgroundColor: "#3e3d32",
      color: "#c5c5a8"
    },
    ".cm-activeLine": {
      backgroundColor: "#3e3d32"
    },
    ".cm-matchingBracket": {
      backgroundColor: "#3b3a32",
      outline: "1px solid #a6e22e"
    },
    ".cm-nonmatchingBracket": {
      color: "#f92672"
    },
    ".cm-tooltip": {
      backgroundColor: "#272822",
      border: "1px solid #49483e",
      color: "#f8f8f2"
    },
    ".cm-tooltip-autocomplete ul li[aria-selected]": {
      backgroundColor: "#3e3d32",
      color: "#f8f8f2"
    }
  }),
  EditorView.darkTheme.of(true),
  syntaxHighlighting(monokaiHighlighter)
];

export const lightTheme = [];