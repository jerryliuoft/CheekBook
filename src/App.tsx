import { useState } from 'react';
import { ImportView } from './components/ImportView';
import { LabView } from './components/LabView';
import { PeopleView } from './components/PeopleView';
import { ScrapbookView } from './components/ScrapbookView';
import { readLocal, writeLocal } from './lib/util';

type Tab = 'photos' | 'book' | 'lab';

const TABS: [Tab, string][] = [
  ['photos', '1 · Photos & people'],
  ['book', '2 · Scrapbook'],
  ['lab', 'Lab'],
];

const TAB_KEY = 'cheekbook.tab';

export default function App() {
  const [tab, setTabState] = useState<Tab>(() => {
    const saved = readLocal<string>(TAB_KEY, 'photos');
    return TABS.some(([t]) => t === saved) ? (saved as Tab) : 'photos';
  });

  function setTab(t: Tab) {
    setTabState(t);
    writeLocal(TAB_KEY, t);
  }

  return (
    <div className={`app ${tab === 'book' ? 'wide' : ''}`}>
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
        {tab === 'photos' && (
          <div className="stack">
            <ImportView />
            <PeopleView onOpenBook={() => setTab('book')} />
          </div>
        )}
        {tab === 'book' && <ScrapbookView />}
        {tab === 'lab' && <LabView />}
      </main>
    </div>
  );
}
