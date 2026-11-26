import { useState } from "react";
import { KantechNavigation } from "./KantechNavigation";
import { KantechReaderGroups } from "./KantechReaderGroups";
import "./KantechReaders.css";

export default function KantechReaders() {
  const [devTools, setDevTools] = useState(false);

  return (
    <main className="kantech-monitor">
      <div className="kantech-monitor__body kantech-readers-view">
        <KantechNavigation view="readers" devTools={devTools} />
        <header className="kantech-monitor__heading"><h1>Czytniki Kantecha</h1></header>
        <KantechReaderGroups onDevToolsChange={setDevTools} />
      </div>
    </main>
  );
}
