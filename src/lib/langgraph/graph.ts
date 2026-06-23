// src/lib/langgraph/graph.ts
import { StateGraph } from '@langchain/langgraph';
import { AjnayaState } from './state';
import { dispatcherAgent } from './agents/dispatcher';
import { contexteAgent } from './agents/contexte';
import { signauxAgent } from './agents/signaux';
import { profilAgent } from './agents/profil';
import { hunterAgent } from './agents/hunter';
import { parrainageAgent } from './agents/parrainage';
import { comptaAgent } from './agents/compta';
import { strategisteAgent } from './agents/strategiste';
import { generateurAgent } from './agents/generateur';
import { persistanceAgent } from './agents/persistance';

export function buildAjnayaGraph() {
  const graph = new StateGraph(AjnayaState)
    // Noeuds
    .addNode('dispatcher', dispatcherAgent)
    .addNode('contexte', contexteAgent)
    .addNode('signaux', signauxAgent)
    .addNode('profil', profilAgent)
    .addNode('hunter', hunterAgent)
    .addNode('parrainage', parrainageAgent)
    .addNode('compta', comptaAgent)
    .addNode('strategiste', strategisteAgent)
    .addNode('generateur', generateurAgent)
    .addNode('persistance', persistanceAgent)

    // Edges : Dispatcher -> parallele (contexte + signaux + profil + hunter + parrainage + compta)
    .addEdge('__start__', 'dispatcher')
    .addEdge('dispatcher', 'contexte')
    .addEdge('dispatcher', 'signaux')
    .addEdge('dispatcher', 'profil')
    .addEdge('dispatcher', 'hunter')
    .addEdge('dispatcher', 'parrainage')
    .addEdge('dispatcher', 'compta')

    // Tous les agents paralleles -> Strategiste
    .addEdge('contexte', 'strategiste')
    .addEdge('signaux', 'strategiste')
    .addEdge('profil', 'strategiste')
    .addEdge('hunter', 'strategiste')
    .addEdge('parrainage', 'strategiste')
    .addEdge('compta', 'strategiste')

    // Strategiste -> Generateur -> Persistance -> Fin
    .addEdge('strategiste', 'generateur')
    .addEdge('generateur', 'persistance')
    .addEdge('persistance', '__end__');

  return graph.compile();
}

// Singleton pour reutiliser le graphe compile
let _compiledGraph: ReturnType<typeof buildAjnayaGraph> | null = null;

export function getAjnayaGraph() {
  if (!_compiledGraph) {
    _compiledGraph = buildAjnayaGraph();
  }
  return _compiledGraph;
}
