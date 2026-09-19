import { useSimStore } from './store';
import { Header } from './components/Header';
import { ClientPanel } from './components/ClientPanel';
import { CenterPanel } from './components/CenterPanel';
import { Timeline } from './components/Timeline';

export default function App() {
  const sim = useSimStore();
  const { state, dispatch } = sim;

  return (
    <div className="app">
      <Header sim={sim} />
      <main className="layout">
        <ClientPanel client={state.clients.A} server={state.server} dispatch={dispatch} />
        <CenterPanel state={state} dispatch={dispatch} />
        <ClientPanel client={state.clients.B} server={state.server} dispatch={dispatch} />
      </main>
      <Timeline events={state.events} />
    </div>
  );
}
