import { useLiveQuery } from 'dexie-react-hooks';
import type Konva from 'konva';
import { useEffect, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { Image as KImage, Layer, Rect, Stage, Transformer } from 'react-konva';
import { db, type Sticker } from '../db';
import { BOOK_STYLES, bookStyle, type BookStyle } from '../lib/bookStyles';
import { tapeColors, token } from '../lib/theme';
import {
  PAGE_H,
  PAGE_W,
  clearBook,
  placeSticker,
  returnToSheet,
  shuffleIntoBook,
  shufflePage,
} from '../pipeline/book';
import { updateSettings, useSettings } from '../settings';
import { Empty } from './common';
import { useImageBitmap } from './hooks';
import { StickerSheet, STICKER_DRAG_TYPE } from './StickerSheet';

const PER_PAGE_CHOICES = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16];
const FLIP_MS = 750;

type Flip = { from: number; to: number; dir: 'next' | 'prev' };

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function ScrapbookView() {
  const settings = useSettings();
  const style = bookStyle(settings.bookStyle);
  const total = useLiveQuery(() => db.stickers.count());
  const lastPage = useLiveQuery(async () => (await db.stickers.orderBy('page').last())?.page ?? -1);
  const [minPages, setMinPages] = useState(1); // blank pages added with Add page
  const [chosen, setChosen] = useState(0);
  const [flip, setFlip] = useState<Flip | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [offPage, setOffPage] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const column = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);

  const pageCount = Math.max(minPages, (lastPage ?? -1) + 1);
  const showBook = !!total && lastPage != null; // the column exists from then on
  const page = Math.min(chosen, pageCount - 1);

  // Fit the page to the column, and to the window height so a whole page shows.
  useEffect(() => {
    const el = column.current;
    if (!el) return;
    const fit = () => {
      const byWidth = el.clientWidth - 44; // cover board and spine around the page
      const byHeight = ((window.innerHeight - 250) * PAGE_W) / PAGE_H;
      setWidth(Math.max(280, Math.min(byWidth, byHeight, 820)));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    window.addEventListener('resize', fit);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, [showBook]);

  function goTo(n: number, count = pageCount) {
    if (n === page || n < 0 || n >= count || flip) return;
    setSelectedId(null);
    if (!reducedMotion()) setFlip({ from: page, to: n, dir: n > page ? 'next' : 'prev' });
    setChosen(n);
  }

  function addPage() {
    setMinPages(pageCount + 1);
    goTo(pageCount, pageCount + 1);
  }

  // Arrow keys turn pages; Delete puts the selected sticker back on the sheet.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.target as HTMLElement).closest('input, select, textarea')) return;
      if (e.key === 'ArrowRight') goTo(page + 1);
      else if (e.key === 'ArrowLeft') goTo(page - 1);
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId != null) {
        returnToSheet(selectedId);
        setSelectedId(null);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (total == null || lastPage == null) return null;
  if (!total) return <Empty>No stickers yet. Pick people on the Photos tab and make some.</Empty>;

  const scale = width / PAGE_W;
  const height = PAGE_H * scale;

  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setSelectedId(null);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  }

  async function shuffleAll() {
    await run(async () => {
      await shuffleIntoBook(settings.perPage);
      setMinPages(1);
      setChosen(0);
    });
  }

  // Asked on the page, not with window.confirm: embedded browsers block dialogs.
  async function clearAll() {
    setConfirmClear(false);
    await run(async () => {
      await clearBook();
      setMinPages(1);
      setChosen(0);
    });
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDropping(false);
    const id = Number(e.dataTransfer.getData(STICKER_DRAG_TYPE));
    if (!id) return;
    const r = e.currentTarget.getBoundingClientRect();
    placeSticker(id, page, { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale });
  }

  const pageProps = { width, scale, style };

  return (
    <div className="book-layout">
      <section className="book-column" ref={column}>
        <div className="row book-tools">
          <label className="small">
            Style{' '}
            <select value={style.id} onChange={(e) => updateSettings({ bookStyle: e.target.value })}>
              {BOOK_STYLES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="small" title="The most stickers a shuffle puts on one page. You can still add more by hand.">
            Per page{' '}
            <select value={settings.perPage} onChange={(e) => updateSettings({ perPage: Number(e.target.value) })}>
              {PER_PAGE_CHOICES.map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? 'As many as fit' : `Up to ${n}`}
                </option>
              ))}
            </select>
          </label>
          <span className="spacer" />
          <button className="primary" disabled={busy} onClick={shuffleAll} title="Deal every sticker into the book in a new order">
            Shuffle into book
          </button>
          {confirmClear ? (
            <span className="confirm">
              <span className="small">All stickers back to the sheet?</span>
              <button className="danger" disabled={busy} onClick={clearAll}>
                Clear
              </button>
              <button onClick={() => setConfirmClear(false)}>Cancel</button>
            </span>
          ) : (
            <button disabled={busy || lastPage < 0} onClick={() => setConfirmClear(true)}>
              Clear book
            </button>
          )}
        </div>

        <div className="book" data-book={style.id}>
          <div className="book-cover">
            <div
              className={`book-pages ${dropping ? 'dropping' : ''}`}
              style={{ width, height }}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(STICKER_DRAG_TYPE)) return;
                e.preventDefault();
                setDropping(true);
              }}
              onDragLeave={() => setDropping(false)}
              onDrop={onDrop}
            >
              {flip ? (
                <>
                  <BookPage {...pageProps} page={flip.dir === 'next' ? flip.to : flip.from} />
                  <div
                    className={`leaf ${flip.dir}`}
                    style={{ animationDuration: `${FLIP_MS}ms` }}
                    onAnimationEnd={(e) => e.target === e.currentTarget && setFlip(null)}
                  >
                    <div className="leaf-front">
                      <BookPage {...pageProps} page={flip.dir === 'next' ? flip.from : flip.to} />
                    </div>
                    <div className="leaf-back" />
                  </div>
                </>
              ) : (
                <BookPage
                  {...pageProps}
                  page={page}
                  interactive
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onOffPage={setOffPage}
                />
              )}
              {offPage && <div className="page-hint">Let go to put it back on the sheet</div>}
            </div>
          </div>
        </div>

        <div className="row book-nav">
          <button disabled={page <= 0 || !!flip} onClick={() => goTo(page - 1)} aria-label="Previous page">
            ‹
          </button>
          <span className="page-num">
            Page {page + 1} of {pageCount}
          </span>
          <button disabled={page >= pageCount - 1 || !!flip} onClick={() => goTo(page + 1)} aria-label="Next page">
            ›
          </button>
          <span className="spacer" />
          {selectedId != null ? (
            <button
              onClick={() => {
                returnToSheet(selectedId);
                setSelectedId(null);
              }}
            >
              Back to sheet
            </button>
          ) : (
            <button disabled={busy} onClick={() => run(() => shufflePage(page))}>
              Shuffle page
            </button>
          )}
          <button disabled={!!flip} onClick={addPage}>
            Add page
          </button>
        </div>
        <p className="muted small">
          Drag stickers to move them, or off the page to put them back. Click one to turn or resize it. Arrow keys turn
          pages.
        </p>
      </section>

      <StickerSheet disabled={!!flip} onAdd={(id) => placeSticker(id, page)} />
    </div>
  );
}

function BookPage(props: {
  page: number;
  width: number;
  scale: number;
  style: BookStyle;
  interactive?: boolean;
  selectedId?: number | null;
  onSelect?: (id: number | null) => void;
  onOffPage?: (off: boolean) => void;
}) {
  const { page, width, scale, style, interactive } = props;
  const stickers = useLiveQuery(() => db.stickers.where('page').equals(page).toArray(), [page]);
  const height = PAGE_H * scale;
  const deselect = (e: Konva.KonvaEventObject<Event>) => e.target === e.target.getStage() && props.onSelect?.(null);

  return (
    <div className="page-paper" style={{ width, height }}>
      <div className="page-title" style={{ '--title-size': `${46 * scale}px` } as CSSProperties}>
        {style.title(page + 1)}
      </div>
      {interactive && stickers && !stickers.length && (
        <div className="page-empty" style={{ fontSize: 30 * scale }}>
          Drag stickers here from the sheet,
          <br />
          or press Shuffle into book.
        </div>
      )}
      <Stage
        width={width}
        height={height}
        scaleX={scale}
        scaleY={scale}
        listening={!!interactive}
        onMouseDown={deselect}
        onTouchStart={deselect}
      >
        <Layer>
          {(stickers ?? []).map((s) => (
            <StickerNode
              key={s.id}
              sticker={s}
              tape={style.tape}
              selected={s.id === props.selectedId}
              onSelect={() => props.onSelect?.(s.id)}
              onReturned={() => props.onSelect?.(null)}
              onOffPage={props.onOffPage}
            />
          ))}
        </Layer>
      </Stage>
    </div>
  );
}

const isOffPage = (n: Konva.Node) => n.x() < 0 || n.x() > PAGE_W || n.y() < 0 || n.y() > PAGE_H;

function StickerNode(props: {
  sticker: Sticker;
  tape: boolean;
  selected: boolean;
  onSelect: () => void;
  onReturned: () => void;
  onOffPage?: (off: boolean) => void;
}) {
  const { sticker, selected, onSelect } = props;
  const img = useImageBitmap(sticker.blob);
  const node = useRef<Konva.Image>(null);
  const tr = useRef<Konva.Transformer>(null);
  const tapes = tapeColors();
  const tape = tapes[sticker.id % tapes.length];

  useEffect(() => {
    if (selected && tr.current && node.current) {
      tr.current.nodes([node.current]);
      tr.current.getLayer()?.batchDraw();
    }
  }, [selected]);

  if (!img) return null;
  const w = sticker.width * sticker.scale;
  const h = sticker.height * sticker.scale;
  // Tape sits on the sticker's top edge, following its rotation.
  const tapeOffset = -(h / 2 - 14);

  function save() {
    const n = node.current!;
    props.onOffPage?.(false);
    if (isOffPage(n)) {
      props.onReturned();
      returnToSheet(sticker.id);
      return;
    }
    const sx = n.scaleX();
    n.scaleX(1);
    n.scaleY(1);
    db.stickers.update(sticker.id, {
      x: n.x(),
      y: n.y(),
      rotation: n.rotation(),
      scale: sticker.scale * sx,
    });
  }

  return (
    <>
      <KImage
        ref={node}
        image={img}
        x={sticker.x}
        y={sticker.y}
        width={w}
        height={h}
        offsetX={w / 2}
        offsetY={h / 2}
        rotation={sticker.rotation}
        draggable
        onMouseDown={onSelect}
        onTap={onSelect}
        onDragStart={onSelect}
        onDragMove={(e) => props.onOffPage?.(isOffPage(e.target))}
        onDragEnd={save}
        onTransformEnd={save}
      />
      {props.tape && sticker.id % 3 === 0 && (
        // A strip of washi tape across the top of every third sticker.
        <Rect
          x={sticker.x - tapeOffset * Math.sin((sticker.rotation * Math.PI) / 180)}
          y={sticker.y + tapeOffset * Math.cos((sticker.rotation * Math.PI) / 180)}
          width={w * 0.38}
          height={34}
          offsetX={w * 0.19}
          offsetY={17}
          rotation={sticker.rotation - 8}
          fill={tape}
          opacity={0.75}
          listening={false}
        />
      )}
      {selected && (
        <Transformer
          ref={tr}
          keepRatio
          enabledAnchors={['top-left', 'top-right', 'bottom-left', 'bottom-right']}
          rotateAnchorOffset={30}
          anchorSize={14}
          borderStroke={token('--color-selection')}
          anchorStroke={token('--color-selection')}
          anchorFill={token('--color-surface')}
        />
      )}
    </>
  );
}
