'use strict';

require('dotenv').config();
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI;
const INDEX_NAME = process.env.VECTOR_SEARCH_INDEX_NAME || 'vousfin_vector_index';
const DIMENSIONS = parseInt(process.env.EMBEDDING_DIMENSIONS, 10) || 768;

async function main() {
  if (!MONGO_URI) {
    throw new Error('MONGO_URI is required to create the Atlas Vector Search index');
  }

  await mongoose.connect(MONGO_URI);
  const collection = mongoose.connection.db.collection('vectorDocuments');

  const definition = {
    fields: [
      {
        type: 'vector',
        path: 'embedding',
        numDimensions: DIMENSIONS,
        similarity: 'cosine',
      },
      { type: 'filter', path: 'businessId' },
      { type: 'filter', path: 'dataType' },
      { type: 'filter', path: 'period' },
    ],
  };

  try {
    const existing = await collection.listSearchIndexes(INDEX_NAME).toArray();
    if (existing.length) {
      await collection.updateSearchIndex(INDEX_NAME, definition);
      console.log(`Updated Atlas Vector Search index "${INDEX_NAME}" on vectorDocuments`);
    } else {
      await collection.createSearchIndex({
        name: INDEX_NAME,
        type: 'vectorSearch',
        definition,
      });
      console.log(`Created Atlas Vector Search index "${INDEX_NAME}" on vectorDocuments`);
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(async (error) => {
  console.error(`Failed to create Atlas Vector Search index: ${error.message}`);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
