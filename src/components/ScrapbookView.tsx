import { useLiveQuery } from 'dexie-react-hooks';
import type Konva from 'konva';
import { useEffect, useRef, useState } from 'react';
import { Image as KImage, Layer, Rect, Stage, Transformer } from 'react-konva';
import { db, type Sticker } from '../db';
import { tapeColors, token } from '../lib/theme';
import { PAGE_H, PAGE_W, reshufflePage } from '../pipeline/makeStickers';
import { Empty } from './common';
import { useImageBitmap } from './hooks';

export function ScrapbookView() {
  const pages = useLiveQuery(async () => {
    const keys = (await db.stickers.orderBy('page').uniqueKeys()) as number[];
    return keys.filter((k) => k >= 0);
  });
  const [chosenPage, setPage] = useState(0);
  // Fall back to the last page when the chosen one has emptied out.
  const page = !pages?.length || pages.includes(chosenPage) ? chosenPage : pages[pages.length - 1];
  const stickers = useLiveQuery(() => db.stickers.where('page').equals(page).toArray(), [page]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.min(el.clientWidth, 760)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (!pages) return null;
  if (!pages.length) return <Empty>No stickers yet. Make some in step 3.</Empty>;

  const scale = width / PAGE_W;
  const idx = pages.indexOf(page);

  return (
    <section className="panel book">
      <div className="row book-nav">
        <button disabled={idx <= 0} onClick={() => setPage(pages[idx - 1])}>
          ← Previous
        </button>
        <span className="page-num">
          Page {idx + 1} of {pages.length}
        </span>
        <button disabled={idx >= pages.length - 1} onClick={() => setPage(pages[idx + 1])}>
          Next →
        </button>
        <span className="spacer" />
        <button onClick={() => reshufflePage(page)}>Shuffle page</button>
        {selectedId != null && (
          <button
            onClick={() => {
              db.stickers.delete(selectedId);
              setSelectedId(null);
            }}
          >
            Delete sticker
          </button>
        )}
      </div>
      <div className="page-wrap" ref={wrap}>
        <div className="page-paper" style={{ width, height: PAGE_H * scale }}>
          <div className="page-title" style={{ fontSize: 46 * scale }}>
            little cheeks · page {idx + 1}
          </div>
          <Stage
            width={width}
            height={PAGE_H * scale}
            scaleX={scale}
            scaleY={scale}
            onMouseDown={(e) => e.target === e.target.getStage() && setSelectedId(null)}
            onTouchStart={(e) => e.target === e.target.getStage() && setSelectedId(null)}
          >
            <Layer>
              {(stickers ?? []).map((s) => (
                <StickerNode
                  key={s.id}
                  sticker={s}
                  selected={s.id === selectedId}
                  onSelect={() => setSelectedId(s.id)}
                />
              ))}
            </Layer>
          </Stage>
        </div>
      </div>
      <p className="muted small">Drag stickers to move them. Click one to rotate or resize it.</p>
    </section>
  );
}

function StickerNode({ sticker, selected, onSelect }: { sticker: Sticker; selected: boolean; onSelect: () => void }) {
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
        onDragEnd={save}
        onTransformEnd={save}
      />
      {sticker.id % 3 === 0 && (
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
