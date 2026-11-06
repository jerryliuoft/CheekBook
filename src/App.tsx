import { useState } from 'react';
import { ImportView } from './components/ImportView';
import { LabView } from './components/LabView';
import { PeopleView } from './components/PeopleView';
import { ScrapbookView } from './components/ScrapbookView';
import { StickersView } from './components/StickersView';
import { readLocal, writeLocal } from './lib/util';

type Tab = 'import' | 'people' | 'stickers' | 'book' | 'lab';

const TABS: [Tab, string][] = [
  ['import', '1 · Photos'],
  ['people', '2 · People'],
  ['stickers', '3 · Stickers'],
  ['book', '4 · Scrapbook'],
  ['lab', 'Lab'],
];

const PERSON_KEY = 'cheekbook.person';

export default function App() {
  const [tab, setTab] = useState<Tab>('import');
  const [personId, setPersonIdState] = useState(() => readLocal<number | null>(PERSON_KEY, null));

  function setPersonId(id: number) {
    setPersonIdState(id);
    writeLocal(PERSON_KEY, id);
  }

  return (
    <div className="app">
      <header>
        <h1>
          Cheek<span>Book</span>
        </h1>
        <nav>
          {TABS.map(([t, label]) => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              {label}
            </button>
          ))}
        </nav>
      </header>
      <main>
        {tab === 'import' && <ImportView onDone={() => setTab('people')} />}
        {tab === 'people' && (
          <PeopleView
            onPick={(id) => {
              setPersonId(id);
              setTab('stickers');
            }}
          />
        )}
        {tab === 'stickers' && (
          <StickersView personId={personId} onPersonChange={setPersonId} onDone={() => setTab('book')} />
        )}
        {tab === 'book' && <ScrapbookView />}
        {tab === 'lab' && <LabView />}
      </main>
    </div>
  );
}
