import assert from 'node:assert/strict';
import { routeWorkspaceVector, normalizeRoutingVector } from '../dist/routing.js';
import { trainWorkspaceRouter } from '../../scripts/train-workspace-router.mjs';

const model = { schemaVersion:1, strategy:'cosine', version:'test', embeddingModel:'test-embed', dimensions:2,
  workspaceSlugs:['W2','W1','W3'], catalogHash:'catalog-v1', prototypes:[[[0,1]],[[1,0]],[[-1,0]]],
  policy:{minScore:0.6,relativeWindow:0.1,minCandidates:1,maxCandidates:2} };
const route = (m,v,slugs=['W1','W2','W3']) => routeWorkspaceVector(m,v,slugs,'test-embed','catalog-v1');
assert.deepEqual(route(model,[1,1]).selected,['W1','W2']);
assert.deepEqual(route(model,[10,0]).selected,['W1']);
assert.equal(route(model,[0,-1]).abstained,true);
assert.deepEqual(route(model,[1,1]),route(model,[1,1],['W3','W2','W1']));
assert.equal(route(model,[1,0],['W1','W2','W3','W4']).reason,'workspace_catalog_changed');
assert.equal(route(model,[1,0],['W1','W1','W3']).abstained,true);
assert.equal(route(model,[0,0]).reason,'invalid_query_vector');
assert.equal(route(model,[NaN,0]).abstained,true);
assert.equal(route(model,[1]).abstained,true);
assert.equal(route({...model,workspaceSlugs:['W1','W1','W3']},[1,0]).reason,'invalid_classes');
assert.equal(route({...model,prototypes:[[[0,0]],[[1,0]],[[-1,0]]]},[1,0]).reason,'invalid_prototypes');
assert.equal(routeWorkspaceVector(model,[1,0],model.workspaceSlugs,'changed','catalog-v1').reason,'embedding_model_changed');
assert.equal(routeWorkspaceVector(model,[1,0],model.workspaceSlugs,'test-embed','changed').reason,'catalog_changed');
assert.deepEqual(normalizeRoutingVector([Number.MAX_VALUE,Number.MAX_VALUE]),normalizeRoutingVector([1,1]));

const training = { workspaceSlugs:['W1','W2'],embeddingModel:'test-embed',catalogHash:'catalog-v1', examples:[
  {id:'a',embedding:[1,0],labels:[1,0]}, {id:'b',embedding:[-1,0],labels:[0,1]},
  {id:'c',embedding:[0.9,0.1],labels:[1,0]}, {id:'d',embedding:[-0.9,0.1],labels:[0,1]},
] };
const trained = trainWorkspaceRouter(training,{l2:0.01,iterations:200});
const masked = trainWorkspaceRouter({...training,examples:[...training.examples,
  {id:'unknown',embedding:[0,1],labels:[null,null]}]},{l2:0.01,iterations:200});
assert.deepEqual(trained.weights,masked.weights);
assert.deepEqual(trained.intercepts,masked.intercepts);
const exported = JSON.parse(JSON.stringify(trained));
exported.policy = {minScore:0.5,relativeWindow:0.1,minCandidates:1,maxCandidates:2};
const actual = route(exported,[1,0],['W2','W1']);
assert.deepEqual(actual.selected,['W1']);
for (let i=0;i<2;i++) {
  const expected = 1/(1+Math.exp(-(exported.weights[i][0]+exported.intercepts[i])));
  assert.ok(Math.abs(actual.scores.find(s=>s.workspace===exported.workspaceSlugs[i]).score-expected)<1e-12);
}
assert.throws(()=>trainWorkspaceRouter({...training,examples:training.examples.map(x=>({...x,labels:[1,0]}))}),/positive and negative/);
console.log('Routing: multilabel decisions, abstention, catalog changes, numeric validation, order invariance, masked training and export parity passed.');
