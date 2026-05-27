// middleware/validate.middleware.js
/**
 * Request validation middleware using Joi.
 *
 * Options used:
 *   abortEarly: false   – collect ALL validation errors, not just the first
 *   allowUnknown: true  – silently ignore any extra fields the client sends.
 *                         This future-proofs the API: new frontend fields never
 *                         cause a 400 until the schema is explicitly updated.
 *
 * @param {Joi.Schema} schema - Joi validation schema
 * @param {string} property - Request property to validate ('body', 'query', 'params')
 * @returns {Function} Express middleware
 */
const validate = (schema, property = 'body') => {
  return (req, res, next) => {
    const { error } = schema.validate(req[property], {
      abortEarly:   false,
      allowUnknown: true,   // never reject unknown keys — prevents "field is not allowed" 400s
    });
    if (error) {
      const messages = error.details.map(detail => detail.message).join(', ');
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors:  messages,
        details: error.details.map(detail => ({
          field:   detail.path.join('.'),
          message: detail.message,
        })),
      });
    }
    next();
  };
};

module.exports = validate;