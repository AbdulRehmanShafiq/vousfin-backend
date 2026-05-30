// services/forecasting/platform/index.js
//
// Forecast Platform — Foundation (F1). Public surface of the foundation data layer.
'use strict';

module.exports = {
  tenantScope:        require('./tenantScope'),
  timezone:           require('./timezone'),
  CurrencyNormalizer: require('./currencyNormalizer'),
  dataValidation:     require('./dataValidation'),
  datasetBuilder:     require('./datasetBuilder.service'),
  featureStore:       require('./featureStore.service'),
};
