/**
 * @module nlParser
 * @description Module entry point for the Natural Language Transaction Parser.
 * Exports the router and parser service for integration into the main MERN backend.
 *
 * Usage in your existing Express app:
 *
 *   const nlParserRoutes = require('./modules/nlParser');
 *   app.use('/api/nl-parser', nlParserRoutes);
 */

const nlParserRoutes = require('./routes/nlParserRoutes');
const { parseTransaction } = require('./services/parserService');

module.exports = nlParserRoutes;
module.exports.parseTransaction = parseTransaction;
