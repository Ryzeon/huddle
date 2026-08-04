import type { SessionState } from '../../domain/session-state.js';
import { mentionables } from '../../domain/session-state.js';
import { formatEntry, splitMentions, type FormattedEntry } from '../../domain/chat-log.js';
import {
  applyMention,
  findMentionQuery,
  parseDraft,
  rankMentions,
  type MentionQuery,
} from '../../domain/composer.js';
import { clear, el, need } from './dom.js';
import { botonCopiar, renderMarkdown, textoPlano } from './markdown-view.js';

export interface ChatViewHandlers {
  onMessage(text: string): void;
  onAsk(to: string, question: string): void;
  onInvalid(reason: string): void;
}

const MAX_SUGGESTIONS = 6;

export class ChatView {
  private readonly list: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly suggestions: HTMLElement;
  private readonly hint: HTMLElement;
  private rendered = new Set<string>();
  private candidates: string[] = [];
  private active = -1;
  private mention: MentionQuery | null = null;
  private stickToBottom = true;

  constructor(private readonly root: HTMLElement, private readonly handlers: ChatViewHandlers) {
    this.list = need<HTMLElement>('[data-chat-lista]', root);
    this.input = need<HTMLTextAreaElement>('[data-chat-entrada]', root);
    this.suggestions = need<HTMLElement>('[data-chat-sugerencias]', root);
    this.hint = need<HTMLElement>('[data-chat-pista]', root);

    this.list.addEventListener('scroll', () => {
      const distance = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight;
      this.stickToBottom = distance < 48;
    });

    this.input.addEventListener('input', () => this.refreshSuggestions());
    this.input.addEventListener('keydown', (event) => this.onKeyDown(event));
    this.input.addEventListener('blur', () => {
      // Con un respiro, para que el clic en una sugerencia llegue antes.
      setTimeout(() => this.closeSuggestions(), 120);
    });
  }

  render(state: SessionState): void {
    this.candidates = mentionables(state);
    for (const entry of state.entries) {
      if (this.rendered.has(entry.id)) continue;
      this.rendered.add(entry.id);
      this.list.appendChild(renderEntry(formatEntry(entry), state.you));
    }
    if (this.stickToBottom) this.list.scrollTop = this.list.scrollHeight;

    const disabled = state.closed || state.status === 'idle';
    this.input.disabled = disabled;
    this.input.placeholder = disabled
      ? 'no estás en ninguna sala'
      : 'escribe, o /ask @alias tu pregunta';
  }

  focus(): void {
    this.input.focus();
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (this.mention && this.active >= 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        const options = this.suggestions.children.length;
        this.active = (this.active + delta + options) % Math.max(options, 1);
        this.paintSuggestions();
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault();
        this.acceptSuggestion(this.active);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        this.closeSuggestions();
        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.submit();
    }
  }

  private submit(): void {
    const draft = parseDraft(this.input.value);
    switch (draft.kind) {
      case 'empty':
        return;
      case 'message':
        this.handlers.onMessage(draft.text);
        break;
      case 'ask':
        this.handlers.onAsk(draft.to, draft.question);
        break;
      case 'invalid':
        this.handlers.onInvalid(draft.reason);
        break;
    }
    this.input.value = '';
    this.closeSuggestions();
    this.stickToBottom = true;
  }

  private refreshSuggestions(): void {
    const caret = this.input.selectionStart ?? this.input.value.length;
    this.mention = findMentionQuery(this.input.value, caret);
    if (!this.mention) {
      this.closeSuggestions();
      return;
    }
    const ranked = rankMentions(this.mention.query, this.candidates).slice(0, MAX_SUGGESTIONS);
    if (ranked.length === 0) {
      this.closeSuggestions();
      return;
    }
    clear(this.suggestions);
    ranked.forEach((label, index) => {
      const option = el('button', {
        class: 'sugerencia',
        text: label,
        attrs: { type: 'button', role: 'option', 'data-indice': index },
      });
      option.addEventListener('mousedown', (event) => {
        event.preventDefault();
        this.acceptSuggestion(index);
      });
      this.suggestions.appendChild(option);
    });
    this.active = 0;
    this.suggestions.hidden = false;
    this.hint.textContent = 'enter o tab para completar · ↑↓ para elegir';
    this.paintSuggestions();
  }

  private paintSuggestions(): void {
    [...this.suggestions.children].forEach((child, index) => {
      child.classList.toggle('sugerencia--activa', index === this.active);
      child.setAttribute('aria-selected', index === this.active ? 'true' : 'false');
    });
  }

  private acceptSuggestion(index: number): void {
    const option = this.suggestions.children[index];
    const mention = this.mention;
    if (!option || !mention) return;
    const applied = applyMention(this.input.value, mention, option.textContent ?? '');
    this.input.value = applied.text;
    this.input.setSelectionRange(applied.caret, applied.caret);
    this.closeSuggestions();
    this.input.focus();
  }

  private closeSuggestions(): void {
    this.suggestions.hidden = true;
    this.mention = null;
    this.active = -1;
    clear(this.suggestions);
    this.hint.textContent = 'enter envía · mayús+enter salta de línea';
  }
}

function renderEntry(entry: FormattedEntry, you: string | null): HTMLElement {
  const row = el('article', {
    class: `entrada entrada--${entry.tone}${entry.quoted ? ' entrada--cita' : ''}`,
    attrs: { 'data-id': entry.id },
  });

  row.appendChild(el('span', { class: 'entrada__glifo', attrs: { 'aria-hidden': 'true' }, text: entry.glyph }));

  const body = el('div', { class: 'entrada__cuerpo' });
  const head = el('p', { class: 'entrada__cabeza' });

  if (entry.alias) {
    const alias = el('b', {
      class: `entrada__alias${entry.alias === you ? ' entrada__alias--tu' : ''}`,
      text: entry.alias,
    });
    head.appendChild(alias);
    head.appendChild(document.createTextNode(' '));
  }

  if (entry.quoted) {
    body.appendChild(head);

    // Las respuestas del agente vienen en markdown; lo que escribe una persona
    // en el chat, no. Renderizarlo todo igual convertiría un asterisco suelto
    // en cursiva sin que nadie lo pidiera.
    const text = el('div', { class: 'entrada__texto' });
    if (entry.markdown) {
      text.appendChild(renderMarkdown(entry.text));
      body.appendChild(text);
      body.appendChild(botonCopiar(textoPlano(entry.text), 'copiar la respuesta'));
    } else {
      for (const chunk of splitMentions(entry.text)) {
        if (chunk.kind === 'mention') {
          text.appendChild(el('span', { class: 'mencion', text: chunk.value }));
        } else {
          text.appendChild(document.createTextNode(chunk.value));
        }
      }
      body.appendChild(text);
    }
  } else {
    head.appendChild(document.createTextNode(entry.text));
    body.appendChild(head);
  }

  if (entry.meta) body.appendChild(el('p', { class: 'entrada__meta', text: entry.meta }));

  if (entry.sources && entry.sources.length > 0) {
    const sources = el('ul', { class: 'entrada__fuentes' });
    for (const source of entry.sources) {
      sources.appendChild(el('li', { text: source }));
    }
    body.appendChild(sources);
  }

  row.appendChild(body);
  row.appendChild(el('time', { class: 'entrada__hora', text: entry.time }));
  return row;
}
