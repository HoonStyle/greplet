// Offline training only. Input questions, class names and exported weights remain private.
// node scripts/train-workspace-router.mjs <private-config.json>
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { normalizeRoutingVector, validateRoutingModel } from '../indexer/dist/routing.js';

export function trainWorkspaceRouter(input, options = {}) {
  const { workspaceSlugs, examples, embeddingModel, catalogHash } = input;
  if (!Array.isArray(workspaceSlugs) || !workspaceSlugs.length || new Set(workspaceSlugs).size !== workspaceSlugs.length)
    throw new Error('Expected distinct workspace classes');
  if (!Array.isArray(examples) || examples.length < 2 || new Set(examples.map(x => x.id)).size !== examples.length)
    throw new Error('Expected distinct training examples');
  const dimensions = examples[0].embedding.length;
  const features = examples.map(row => {
    if (row.embedding.length !== dimensions || row.labels.length !== workspaceSlugs.length ||
        !row.labels.every(x => x === 0 || x === 1 || x === null)) throw new Error('Invalid training shape/labels');
    return Float64Array.from(normalizeRoutingVector(row.embedding));
  });
  const l2 = options.l2 ?? 0.01;
  const iterations = options.iterations ?? 600;
  const learningRate = options.learningRate ?? 1 / (0.5 + l2);
  if (!Number.isFinite(l2) || l2 <= 0 || !Number.isInteger(iterations) || iterations < 1 ||
      !Number.isFinite(learningRate) || learningRate <= 0 || learningRate > 1 / (0.5 + l2))
    throw new Error('Invalid training parameters');
  const weights = [], intercepts = [], support = [], losses = [];
  for (let c = 0; c < workspaceSlugs.length; c++) {
    const known = examples.flatMap((row, i) => row.labels[c] === null ? [] : [i]);
    const positives = known.filter(i => examples[i].labels[c] === 1).length;
    if (!positives || positives === known.length) throw new Error('Every class requires known positive and negative examples');
    const w = new Float64Array(dimensions), grad = new Float64Array(dimensions);
    let b = Math.log(positives / (known.length - positives));
    for (let step = 0; step < iterations; step++) {
      grad.fill(0);
      let biasGrad = 0;
      for (const i of known) {
        const x = features[i];
        let z = b;
        for (let j = 0; j < dimensions; j++) z += w[j] * x[j];
        const probability = z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
        const residual = probability - examples[i].labels[c];
        biasGrad += residual;
        for (let j = 0; j < dimensions; j++) grad[j] += residual * x[j];
      }
      for (let j = 0; j < dimensions; j++) w[j] -= learningRate * (grad[j] / known.length + l2 * w[j]);
      b -= learningRate * biasGrad / known.length;
    }
    let loss = 0;
    for (const i of known) {
      let z = b;
      for (let j = 0; j < dimensions; j++) z += w[j] * features[i][j];
      loss += Math.max(z, 0) + Math.log1p(Math.exp(-Math.abs(z))) - examples[i].labels[c] * z;
    }
    loss = loss / known.length + l2 / 2 * w.reduce((sum, x) => sum + x * x, 0);
    weights.push(Array.from(w)); intercepts.push(b); losses.push(loss);
    support.push({ positive: positives, negative: known.length - positives, unknown: examples.length - known.length });
  }
  const inputHash = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const model = { schemaVersion: 1, strategy: 'logistic', version: `logistic-${inputHash.slice(0,12)}-l2-${l2}`,
    embeddingModel, dimensions, workspaceSlugs, catalogHash, weights, intercepts,
    policy: { minScore: 0.5, relativeWindow: 0.25, minCandidates: 2, maxCandidates: 3 },
    training: { inputHash, examples: examples.length, l2, iterations, learningRate, support, losses,
      normalization: 'L2 unit vector; unknown class labels masked; unweighted known examples' } };
  const invalid = validateRoutingModel(model);
  if (invalid) throw new Error(`Training produced invalid model: ${invalid}`);
  return model;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
  const input = JSON.parse(fs.readFileSync(config.input, 'utf8').replace(/^\uFEFF/, ''));
  if (fs.existsSync(config.output)) throw new Error('Refusing to overwrite a model; use a fresh output path');
  const model = trainWorkspaceRouter(input, config);
  fs.writeFileSync(config.output, JSON.stringify(model));
  console.log(JSON.stringify({ examples: model.training.examples, classes: model.workspaceSlugs.length,
    dimensions: model.dimensions, l2: model.training.l2, maxLoss: Math.max(...model.training.losses) }));
}
