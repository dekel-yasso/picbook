// Precompute CLIP *text* embeddings for the fixed theme labels and ship them
// as JSON, so the app only ever downloads the image encoder (~85MB) and never
// the text encoder. Run: node scripts/gen-theme-embeddings.mjs
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AutoTokenizer, CLIPTextModelWithProjection } from '@huggingface/transformers';

const MODEL_ID = 'Xenova/clip-vit-base-patch32';

const THEMES = [
  { label: 'People', prompt: 'a photo of people' },
  { label: 'Food', prompt: 'a photo of food or a meal' },
  { label: 'Landscape', prompt: 'a landscape photo of nature, mountains or countryside' },
  { label: 'City', prompt: 'a photo of buildings, streets or architecture' },
  { label: 'Water', prompt: 'a photo of the sea, a lake or a beach' },
  { label: 'Night', prompt: 'a photo taken at night' },
  { label: 'Animals', prompt: 'a photo of an animal' },
  { label: 'Art', prompt: 'a photo of artwork or a museum exhibit' },
];

// Scene phrases for chapter captions: `prompt` is what CLIP scores against,
// `caption` is what the book prints.
const SCENES = [
  { caption: 'A day at the beach', prompt: 'a photo of a sandy beach' },
  { caption: 'Up in the mountains', prompt: 'a photo of high mountains' },
  { caption: 'Wandering the old town', prompt: 'a photo of narrow streets in an old town' },
  { caption: 'Along the canals', prompt: 'a photo of canals and gondolas' },
  { caption: 'Out on the water', prompt: 'a photo taken from a boat on the water' },
  { caption: 'By the lake', prompt: 'a photo of a lake shore' },
  { caption: 'Into the woods', prompt: 'a photo of a trail in the forest' },
  { caption: 'Big city lights', prompt: 'a photo of a modern city with tall buildings' },
  { caption: 'A day of art & museums', prompt: 'a photo inside a museum' },
  { caption: 'Among ancient stones', prompt: 'a photo of ancient ruins' },
  { caption: 'Castles & battlements', prompt: 'a photo of a castle' },
  { caption: 'Spires & cathedrals', prompt: 'a photo of a cathedral or an old church' },
  { caption: 'Market day', prompt: 'a photo of a street market' },
  { caption: 'Eating well', prompt: 'a photo of a meal at a restaurant' },
  { caption: 'Poolside', prompt: 'a photo of a swimming pool' },
  { caption: 'In the snow', prompt: 'a photo of a snowy winter landscape' },
  { caption: 'Desert horizons', prompt: 'a photo of a desert landscape' },
  { caption: 'Through the countryside', prompt: 'a photo of vineyards and countryside' },
  { caption: 'Chasing waterfalls', prompt: 'a photo of a waterfall' },
  { caption: 'Down at the harbor', prompt: 'a photo of a harbor with boats' },
  { caption: 'Rides & thrills', prompt: 'a photo of an amusement park' },
  { caption: 'After dark', prompt: 'a photo of a city at night' },
  { caption: 'Wildlife day', prompt: 'a photo of wild animals' },
  { caption: 'On the road', prompt: 'a photo taken on a road trip through scenery' },
];

const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
const model = await CLIPTextModelWithProjection.from_pretrained(MODEL_ID, { dtype: 'fp32' });

async function embedPrompts(prompts) {
  const inputs = tokenizer(prompts, { padding: true, truncation: true });
  const { text_embeds } = await model(inputs);
  const dim = text_embeds.dims[1];
  return prompts.map((_, i) => {
    const row = Array.from(text_embeds.data.slice(i * dim, (i + 1) * dim));
    const norm = Math.hypot(...row);
    return row.map((v) => +(v / norm).toFixed(6));
  });
}

const themeEmbeds = await embedPrompts(THEMES.map((t) => t.prompt));
await writeFile(
  fileURLToPath(new URL('../lib/engine/theme-embeddings.json', import.meta.url)),
  JSON.stringify({ model: MODEL_ID, labels: THEMES.map((t) => t.label), embeddings: themeEmbeds }),
);

const sceneEmbeds = await embedPrompts(SCENES.map((s) => s.prompt));
await writeFile(
  fileURLToPath(new URL('../lib/engine/scene-embeddings.json', import.meta.url)),
  JSON.stringify({ model: MODEL_ID, captions: SCENES.map((s) => s.caption), embeddings: sceneEmbeds }),
);

console.log(`wrote ${THEMES.length} themes and ${SCENES.length} scenes`);
