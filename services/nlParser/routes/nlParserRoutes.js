/**
 * @module nlParserRoutes
 * @description Express routes for the NL Parser module.
 * Mounts the POST /parse endpoint under the /api/nl-parser prefix.
 */

const express = require('express');
const { parseNaturalLanguage } = require('../controllers/nlParserController');

const router = express.Router();

/**
 * POST /api/nl-parser/parse
 * Parse a natural language transaction description into a structured journal entry.
 *
 * Body: { "text": "Paid Rs 8,000 electricity bill yesterday through HBL bank" }
 */
router.post('/parse', parseNaturalLanguage);

module.exports = router;
