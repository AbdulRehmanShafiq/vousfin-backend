// scripts/createAdmin.js
const mongoose = require('mongoose');
const readline = require('readline');
const bcrypt = require('bcryptjs');
const config = require('../config');
const User = require('../models/User.model');

// Set up readline for interactive input (optional)
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

/**
 * Main function to create admin user.
 */
const createAdmin = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(config.MONGO_URI);
    console.log('✅ Connected to MongoDB');

    // Collect admin details
    const email = await question('Admin email: ');
    const fullName = await question('Admin full name: ');
    const password = await question('Admin password (min 8 chars, 1 uppercase, 1 number, 1 special): ');

    // Basic validation
    if (!email || !fullName || !password) {
      throw new Error('All fields are required');
    }
    if (password.length < 8) {
      throw new Error('Password must be at least 8 characters');
    }

    // Check if user already exists
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      console.log('⚠️  User already exists. Do you want to update to admin?');
      const answer = await question('Update role to admin? (y/n): ');
      if (answer.toLowerCase() === 'y') {
        existing.role = 'admin';
        existing.status = 'active';
        existing.authProvider = 'local';
        if (password) {
          existing.passwordHash = await bcrypt.hash(password, 12);
        }
        await existing.save();
        console.log('✅ User updated to admin successfully');
      } else {
        console.log('❌ Aborted');
      }
      process.exit(0);
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Create admin user
    const admin = new User({
      fullName,
      email: email.toLowerCase(),
      passwordHash,
      authProvider: 'local',
      role: 'admin',
      status: 'active',
      verificationToken: null,
      businessId: null,
    });
    await admin.save();

    console.log('✅ Admin user created successfully!');
    console.log(`   Email: ${email}`);
    console.log(`   Role: admin`);
    process.exit(0);
  } catch (error) {
    console.error('❌ Error creating admin:', error.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    rl.close();
  }
};

// Run the script
createAdmin();