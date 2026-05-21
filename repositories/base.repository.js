// repositories/base.repository.js
/**
 * Generic base repository providing common CRUD operations.
 * @template T - Mongoose model type
 */
class BaseRepository {
  /**
   * @param {import('mongoose').Model} model - Mongoose model
   */
  constructor(model) {
    this.model = model;
  }

  /**
   * Create a new document.
   * @param {Object} data - Document data
   * @returns {Promise<Object>} Created document
   */
  async create(data) {
    try {
      const document = new this.model(data);
      return await document.save();
    } catch (error) {
      throw new Error(`Error creating document: ${error.message}`);
    }
  }

  /**
   * Find document by ID.
   * @param {string|import('mongoose').Types.ObjectId} id
   * @param {string|Array} populateFields - Fields to populate (e.g., 'userId' or ['userId', 'businessId'])
   * @returns {Promise<Object|null>}
   */
  async findById(id, populateFields = null) {
    try {
      let query = this.model.findById(id);
      if (populateFields) {
        if (Array.isArray(populateFields)) {
          populateFields.forEach(field => {
            query = query.populate(field);
          });
        } else {
          query = query.populate(populateFields);
        }
      }
      return await query.exec();
    } catch (error) {
      throw new Error(`Error finding document by ID: ${error.message}`);
    }
  }

  /**
   * Find a single document matching conditions.
   * @param {Object} conditions - MongoDB query conditions
   * @param {string|Array} populateFields - Optional populate
   * @returns {Promise<Object|null>}
   */
  async findOne(conditions, populateFields = null) {
    try {
      let query = this.model.findOne(conditions);
      if (populateFields) {
        if (Array.isArray(populateFields)) {
          populateFields.forEach(field => {
            query = query.populate(field);
          });
        } else {
          query = query.populate(populateFields);
        }
      }
      return await query.exec();
    } catch (error) {
      throw new Error(`Error finding document: ${error.message}`);
    }
  }

  /**
   * Find multiple documents with pagination and sorting.
   * @param {Object} conditions - MongoDB query conditions
   * @param {Object} options - { page, limit, sort, select }
   * @returns {Promise<{data: Array, total: number, page: number, limit: number}>}
   */
  async findAll(conditions = {}, options = {}) {
    const {
      page = 1,
      limit = 25,
      sort = { createdAt: -1 },
      select = null,
      populate = null,
    } = options;

    const skip = (page - 1) * limit;

    try {
      let query = this.model.find(conditions);
      if (select) query = query.select(select);
      if (populate) {
        if (Array.isArray(populate)) {
          populate.forEach(field => {
            query = query.populate(field);
          });
        } else {
          query = query.populate(populate);
        }
      }
      const [data, total] = await Promise.all([
        query.sort(sort).skip(skip).limit(limit).exec(),
        this.model.countDocuments(conditions),
      ]);
      return { data, total, page, limit };
    } catch (error) {
      throw new Error(`Error finding documents: ${error.message}`);
    }
  }

  /**
   * Update a document by ID.
   * @param {string|import('mongoose').Types.ObjectId} id
   * @param {Object} updateData - Fields to update
   * @param {Object} options - Mongoose update options (e.g., { new: true })
   * @returns {Promise<Object|null>}
   */
  async update(id, updateData, options = { new: true }) {
    try {
      return await this.model.findByIdAndUpdate(id, updateData, options).exec();
    } catch (error) {
      throw new Error(`Error updating document: ${error.message}`);
    }
  }

  /**
   * Permanently delete a document by ID.
   * Note: For financial systems, prefer soft deletion (setting a status field).
   * @param {string|import('mongoose').Types.ObjectId} id
   * @returns {Promise<Object|null>}
   */
  async delete(id) {
    try {
      return await this.model.findByIdAndDelete(id).exec();
    } catch (error) {
      throw new Error(`Error deleting document: ${error.message}`);
    }
  }

  /**
   * Count documents matching conditions.
   * @param {Object} conditions
   * @returns {Promise<number>}
   */
  async count(conditions = {}) {
    try {
      return await this.model.countDocuments(conditions);
    } catch (error) {
      throw new Error(`Error counting documents: ${error.message}`);
    }
  }

  /**
   * Check if any document exists matching conditions.
   * @param {Object} conditions
   * @returns {Promise<boolean>}
   */
  async exists(conditions) {
    try {
      const count = await this.model.countDocuments(conditions).limit(1);
      return count > 0;
    } catch (error) {
      throw new Error(`Error checking existence: ${error.message}`);
    }
  }

  /**
   * Run an aggregation pipeline.
   * @param {Array} pipeline - Mongoose aggregation pipeline
   * @returns {Promise<Array>}
   */
  async aggregate(pipeline) {
    try {
      return await this.model.aggregate(pipeline);
    } catch (error) {
      throw new Error(`Aggregation error: ${error.message}`);
    }
  }
}

module.exports = BaseRepository;