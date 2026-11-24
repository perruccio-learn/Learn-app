// Flashcard review session (spaced repetition with FSRS).

import { $, el, clamp, toast } from './util.js?v=3046ab5f78c9';
import {
  NEW_PER_DAY,
  Rating,
  State,
  dayKey,
  deviceId,
  fromFsrsCard,
  humanInterval,
  isDue,
  isNew,
  isTrashed,
  loadMath,
  newIntroducedToday,
  renderRich,
  reviewsToday,
  scheduler,
  toFsrsCard,
} from './cards.js?v=3046ab5f78c9';

const RATINGS = [
  { rating: Rating.Again, label: 'Again', key: '1', cls: 'again' },
  { rating: Rating.Hard, label: 'Hard', key: '2', cls: 'hard' },
  { rating: Rating.Good, label: 'Good', key: '3', cls: 'good' },
  { rating: Rating.Easy, label: 'Easy', key: '4', cls: 'easy' },
];
const REQUEUE_WINDOW_MS = 20 * 60 * 1000;

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Counts for the library summary: {due, fresh, total, trashed, byDeck: {deck: {due, fresh}}}. */
export function summarize(decks, sync, now = Date.now()) {
  const out = { due: 0, fresh: 0, total: decks.cards.length, trashed: 0, byDeck: {} };
  const newLeft = {};
  for (const card of decks.cards) {
    const doc = sync.load(card.dir).doc;
    if (isTrashed(doc, card.id)) {
      out.trashed++;
      continue;
    }
    newLeft[card.dir] ??= Math.max(0, NEW_PER_DAY - newIntroducedToday(doc, now));
    const s = doc.cards[card.id];
    const deck = (out.byDeck[card.deck || card.stem] ??= { due: 0, fresh: 0 });
    if (isNew(s)) {
      if (newLeft[card.dir] > 0) {
        newLeft[card.dir]--;
        out.fresh++;
        deck.fresh++;
      }
    } else if (isDue(s, now)) {
      out.due++;
      deck.due++;
    }
  }
  return out;
}

export class ReviewSession {
  constructor({ sync, onExit }) {
    this.sync = sync;
    this.onExit = onExit;
    this.root = $('#view-review');
    this.queue = [];
    this.current = null;
    this.revealed = false;
    this.history = [];
    this.done = 0;
    this.decks = null;
    this.waitTimer = null;
    this.trash = new TrashDialog({ sync, onChange: () => this._render() });
    this._bind();
  }

  attach(sync) {
    this.sync = sync;
    this.trash.sync = sync;
  }

  /** Leave the review: stop waiting for cards in their learning step. */
  stop() {
    clearTimeout(this.waitTimer);
    this.waitTimer = null;
  }

  // ------------------------------------------------------------------ queue

  start(decks) {
    this.stop();
    this.decks = decks;
    const now = Date.now();
    const learning = [];
    const reviews = [];
    const fresh = [];
    const waiting = [];
    const newLeft = {};
    let doneToday = 0;
    for (const card of decks.cards) {
      const doc = this.sync.load(card.dir).doc;
      if (!(card.dir in newLeft)) {
        newLeft[card.dir] = Math.max(0, NEW_PER_DAY - newIntroducedToday(doc, now));
        doneToday += reviewsToday(doc, now);
      }
      if (isTrashed(doc, card.id)) continue;
      const s = doc.cards[card.id];
      if (isNew(s)) {
        if (newLeft[card.dir] > 0) {
          newLeft[card.dir]--;
          fresh.push(card);
        }
      } else if (isDue(s, now)) {
        if (s.state === State.Review) reviews.push(card);
        else if (s.due <= now) learning.push(card);
        // Rated a few minutes ago (e.g. before closing the page): it comes back when its step is up,
        // as it would have in the same session, instead of restarting the review from these cards.
        else waiting.push({ card, readyAt: s.due });
      }
    }
    // Interleave: learning first, then reviews from all decks shuffled, with a new card every 3 reviews.
    const mixed = [];
    const rev = shuffle(reviews);
    let n = 0;
    while (rev.length || fresh.length) {
      if (fresh.length && (n % 4 === 3 || !rev.length)) mixed.push(fresh.shift());
      else mixed.push(rev.shift());
      n++;
    }
    waiting.sort((a, b) => a.readyAt - b.readyAt);
    this.queue = [...[...learning, ...mixed].map((card) => ({ card, readyAt: 0 })), ...waiting];
    this.history = [];
    this.done = doneToday; // continue today's count across openings and devices
    this._next();
  }

  /**
   * Show the next card that is ready. Cards still in their learning step are not shown
   * early (that made a reopened review start again from the cards just answered): the
   * review waits for them and goes on by itself, or the user can take them now.
   */
  _next({ early = false } = {}) {
    this.stop();
    const docs = {};
    this.queue = this.queue.filter((q) => !isTrashed((docs[q.card.dir] ??= this.sync.load(q.card.dir).doc), q.card.id));
    const now = Date.now();
    let i = this.queue.findIndex((q) => q.readyAt <= now);
    if (i < 0 && early && this.queue.length) {
      i = this.queue.reduce((best, q, k) => (q.readyAt < this.queue[best].readyAt ? k : best), 0);
    }
    this.current = i >= 0 ? this.queue.splice(i, 1)[0].card : null;
    this.revealed = false;
    if (!this.current && this.queue.length) {
      const wait = Math.min(...this.queue.map((q) => q.readyAt)) - now;
      this.waitTimer = setTimeout(() => !this.root.hidden && this._next(), Math.max(0, wait) + 500);
    }
    this._render();
  }

  /** Move the current card to the trash (it keeps its review state; undo from the toast). */
  trashCurrent() {
    const card = this.current;
    if (!card) return;
    setTrashed(this.sync, card, true);
    toast('Card moved to the trash', {
      action: {
        label: 'Undo',
        fn: () => {
          setTrashed(this.sync, card, false);
          if (this.current) this.queue.unshift({ card: this.current, readyAt: 0 });
          this.stop();
          this.current = card;
          this.revealed = false;
          this._render();
        },
      },
    });
    this._next();
  }

  rate(rating) {
    if (!this.current || !this.revealed) return;
    const card = this.current;
    const now = new Date();
    const doc = this.sync.load(card.dir).doc;
    const before = doc.cards[card.id] || null;
    const wasNew = isNew(before);
    const result = scheduler.next(toFsrsCard(before, now), now, rating);
    const after = fromFsrsCard(card.id, result.card);
    const day = dayKey(now.getTime());
    const device = deviceId();
    this.history.push({ card, before, wasNew, day, device, queue: this.queue.map((q) => ({ ...q })) });
    if (this.history.length > 30) this.history.shift();
    this.sync.mutate(
      card.dir,
      (d) => {
        d.cards[card.id] = after;
        d.days[day] ??= {};
        const c = (d.days[day][device] ??= { reviews: 0, new: 0 });
        c.reviews++;
        if (wasNew) c.new++;
      },
      { silent: true },
    );
    if (after.due - now.getTime() < REQUEUE_WINDOW_MS) this.queue.push({ card, readyAt: after.due });
    this.done++;
    this._next();
  }

  undo() {
    const last = this.history.pop();
    if (!last) return;
    const { card, before, wasNew, day, device } = last;
    this.sync.mutate(
      card.dir,
      (d) => {
        // Restore the previous state with a fresh timestamp so the undo wins the merge.
        d.cards[card.id] = before
          ? { ...before, updatedAt: Date.now() }
          : { ...fromFsrsCard(card.id, toFsrsCard(null)), updatedAt: Date.now() };
        const c = d.days[day]?.[device];
        if (c) {
          c.reviews = Math.max(0, c.reviews - 1);
          if (wasNew) c.new = Math.max(0, c.new - 1);
        }
      },
      { silent: true },
    );
    // The snapshot was taken before the next card was drawn, so it already holds the current card.
    this.queue = last.queue;
    this.current = card;
    this.revealed = false;
    this.done = Math.max(0, this.done - 1);
    this._render();
  }

  reveal() {
    if (!this.current || this.revealed) return;
    this.revealed = true;
    this._render();
  }

  // ------------------------------------------------------------------ UI

  _bind() {
    $('#review-card').addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      this.reveal();
    });
    $('#review-show').addEventListener('click', () => this.reveal());
    $('#review-undo').addEventListener('click', () => this.undo());
    $('#review-back').addEventListener('click', () => this.onExit());
    $('#review-finish').addEventListener('click', () => this.onExit());
    $('#review-trash').addEventListener('click', () => this.trashCurrent());
    $('#review-early').addEventListener('click', () => this._next({ early: true }));
    $('#review-open-trash').addEventListener('click', () => this.decks && this.trash.open(this.decks));
    const bar = $('#review-ratings');
    for (const r of RATINGS) {
      bar.append(
        el(
          'button',
          { type: 'button', class: `rate rate-${r.cls}`, dataset: { rating: r.rating }, onclick: () => this.rate(r.rating) },
          el('span', { class: 'rate-label' }, r.label),
          el('span', { class: 'rate-ivl' }),
        ),
      );
    }
    document.addEventListener('keydown', (e) => {
      if (this.root.hidden || this.trash.dialog.open || e.target.closest?.('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.key === ' ' || e.key === 'Enter') && !this.revealed) {
        e.preventDefault();
        this.reveal();
      } else if (this.revealed && ['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault();
        this.rate(Number(e.key));
      } else if (e.key === ' ' && this.revealed) {
        e.preventDefault();
        this.rate(Rating.Good);
      } else if (e.key === 'Delete') {
        e.preventDefault();
        this.trashCurrent();
      } else if (e.key === 'z' || e.key === 'u') {
        this.undo();
      } else if (e.key === 'Escape') {
        this.onExit();
      }
    });
  }

  _render() {
    const card = this.current;
    $('#review-undo').disabled = this.history.length === 0;
    const remaining = this.queue.length + (card ? 1 : 0);
    $('#review-count').textContent = card ? `${remaining} left · ${this.done} done today` : '';
    $('#review-done').hidden = !!card;
    $('#review-stage').hidden = !card;
    $('#review-trash').disabled = !card;
    const trashed = this.decks ? summarize(this.decks, this.sync).trashed : 0;
    $('#review-open-trash').hidden = trashed === 0;
    $('#review-open-trash').textContent = `Trash (${trashed})`;
    if (!card) {
      const waiting = this.queue.length;
      const reviewed = this.done === 0 ? '' : `You reviewed ${this.done} ${this.done === 1 ? 'card' : 'cards'} today. `;
      $('#review-done-text').textContent = waiting
        ? `${reviewed}${waiting} ${waiting === 1 ? 'card comes' : 'cards come'} back in ${humanInterval(Math.max(0, Math.min(...this.queue.map((q) => q.readyAt)) - Date.now()))}, after ${waiting === 1 ? 'its' : 'their'} learning step: the review goes on by itself.`
        : reviewed || 'Nothing to review right now.';
      $('#review-early').hidden = !waiting;
      return;
    }
    const doc = this.sync.load(card.dir).doc;
    const s = doc.cards[card.id];
    $('#review-meta').textContent = [card.deck, card.stem, isNew(s) ? 'new' : null].filter(Boolean).join(' · ');
    renderRich($('#review-front'), card.front);
    const back = $('#review-back-text');
    back.hidden = !this.revealed;
    $('#review-divider').hidden = !this.revealed;
    if (this.revealed) renderRich(back, card.back);
    $('#review-show').hidden = this.revealed;
    $('#review-ratings').hidden = !this.revealed;
    if (this.revealed) {
      const now = new Date();
      const preview = scheduler.repeat(toFsrsCard(s, now), now);
      for (const b of $('#review-ratings').children) {
        const r = Number(b.dataset.rating);
        b.querySelector('.rate-ivl').textContent = humanInterval(clamp(preview[r].card.due.getTime() - now.getTime(), 0, Infinity));
      }
    }
  }
}

/** Put a card in the trash or take it out (synced at once, like an answer). */
export function setTrashed(sync, card, trashed) {
  sync.mutate(card.dir, (d) => (d.trash[card.id] = { id: card.id, trashed, updatedAt: Date.now() }), { silent: true });
}

/** The trash: cards kept with their review state but never reviewed, each one restorable. */
export class TrashDialog {
  constructor({ sync, onChange = () => {} }) {
    this.sync = sync;
    this.onChange = onChange;
    this.decks = null;
    this.dialog = $('#trash-dialog');
    $('#trash-close').addEventListener('click', () => this.dialog.close());
    $('#trash-restore-all').addEventListener('click', () => {
      for (const card of this._cards()) setTrashed(this.sync, card, false);
      this._draw();
    });
    this.dialog.addEventListener('close', () => this.onChange());
  }

  _cards() {
    return (this.decks?.cards || []).filter((c) => isTrashed(this.sync.load(c.dir).doc, c.id));
  }

  async open(decks) {
    this.decks = decks;
    await loadMath();
    this._draw();
    if (!this.dialog.open) this.dialog.showModal();
  }

  _draw() {
    const cards = this._cards();
    $('#trash-empty').hidden = cards.length > 0;
    $('#trash-restore-all').hidden = cards.length < 2;
    $('#trash-list').replaceChildren(
      ...cards.map((card) => {
        const front = el('div', { class: 'trash-front' });
        renderRich(front, card.front);
        return el(
          'li',
          { class: 'trash-item' },
          el('div', { class: 'trash-body' }, el('p', { class: 'review-meta' }, [card.deck, card.stem].filter(Boolean).join(' · ')), front),
          el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { setTrashed(this.sync, card, false); this._draw(); } }, 'Restore'),
        );
      }),
    );
  }
}

export function warnIfLocked(decks) {
  if (!decks.cards.length && decks.locked) toast('Cards unlock when you mark their session as done.');
}
