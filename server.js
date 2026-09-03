const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const basicAuth = require('express-basic-auth');
require('dotenv').config();

const app = express();

// --- Middleware Setup ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Extended urlencoded parsing handles nested form objects like customQuotas[slot]
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Database Connection ---
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/cave_booking';

mongoose.connect(MONGODB_URI)
  .then(() => console.log('Successfully connected to MongoDB Atlas'))
  .catch((err) => console.error('MongoDB connection error:', err));

// --- Database Schemas & Models ---
const bookingSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true },
  phone: { type: String, default: '' },
  timeSlot: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const settingSchema = new mongoose.Schema({
  title: { type: String, default: 'APSS Cave Experience' },
  defaultQuota: { type: Number, default: 10 },
  customQuotas: { type: Map, of: Number, default: {} },
  orderedSlots: { type: [String], default: [] }
});

const Booking = mongoose.model('Booking', bookingSchema);
const Setting = mongoose.model('Setting', settingSchema);

// --- Helper: Generate 10-Min Session Slots with a.m. / p.m. (10:00 a.m. to 4:30 p.m.) ---
function generateDefaultSlots() {
  const slots = [];
  const startHour = 10;
  const endHour = 16; // 16:00 (4:00 p.m.) block

  for (let hour = startHour; hour <= endHour; hour++) {
    // Determine 12-hour display number and period tag (a.m. or p.m.)
    const displayHour = hour > 12 ? hour - 12 : hour;
    const formattedHour = String(displayHour).padStart(2, '0');
    const period = hour >= 12 ? 'p.m.' : 'a.m.';

    // 4 sessions per hour with 5-minute buffer
    const intervals = [
      { start: '00', end: '10' },
      { start: '15', end: '25' },
      { start: '30', end: '40' },
      { start: '45', end: '55' }
    ];

    for (const interval of intervals) {
      // Cut off after 4:25 p.m. session (stops before 4:30 p.m.)
      if (hour === 16 && parseInt(interval.start, 10) >= 30) break;

      slots.push(`${formattedHour}:${interval.start} ${period} - ${formattedHour}:${interval.end} ${period}`);
    }
  }
  return slots;
}

// Helper function to initialize or retrieve system settings
async function getSystemSettings() {
  let settings = await Setting.findOne();
  const defaultSlots = generateDefaultSlots();

  if (!settings) {
    settings = await Setting.create({ orderedSlots: defaultSlots });
  } else if (!settings.orderedSlots || settings.orderedSlots.length === 0) {
    settings.orderedSlots = defaultSlots;
    await settings.save();
  }
  return settings;
}

// --- Public Routes ---

// 1. Home / Booking Page
app.get('/', async (req, res) => {
  try {
    const settings = await getSystemSettings();
    
    res.render('index', { 
      slots: settings.orderedSlots, 
      settings,
      success: false,
      booking: null
    });
  } catch (error) {
    console.error('Error rendering homepage:', error);
    res.status(500).send('Server Error');
  }
});

// 2. Submit Booking Route & Display Confirmation Summary
app.post('/book', async (req, res) => {
  try {
    const { name, email, phone, timeSlot } = req.body;

    const newBooking = new Booking({
      name,
      email,
      phone,
      timeSlot
    });

    await newBooking.save();

    const settings = await getSystemSettings();

    res.render('index', { 
      slots: settings.orderedSlots,
      settings,
      success: true,
      booking: newBooking
    });
  } catch (error) {
    console.error('Error creating booking:', error);
    res.status(500).send('Failed to process booking. Please try again.');
  }
});

// --- Admin Basic Authentication Middleware ---
app.use('/admin', basicAuth({
  users: { 
    [process.env.ADMIN_USER || 'admin']: process.env.ADMIN_PASS || 'cave2026pass' 
  },
  challenge: true, // Prompts browser native login dialog
  realm: 'APSS Cave Admin Area'
}));

// --- Admin Routes ---

// 3. Redirect /admin to /admin/dashboard
app.get('/admin', (req, res) => {
  res.redirect('/admin/dashboard');
});

// 4. Admin Dashboard
app.get('/admin/dashboard', async (req, res) => {
  try {
    const bookings = await Booking.find({}).sort({ createdAt: -1 }).lean();
    const settings = await getSystemSettings();

    res.render('admin-dashboard', {
      bookings,
      settings,
      slots: settings.orderedSlots
    });
  } catch (error) {
    console.error('Error rendering admin dashboard:', error);
    res.status(500).send('Error loading dashboard');
  }
});

// 5. Delete Booking
app.post('/admin/bookings/delete/:id', async (req, res) => {
  try {
    await Booking.findByIdAndDelete(req.params.id);
    res.redirect('/admin/dashboard');
  } catch (error) {
    console.error('Error deleting booking:', error);
    res.status(500).send('Failed to delete entry');
  }
});

// 6. Update Capacity & Settings
app.post('/admin/settings', async (req, res) => {
  try {
    const { defaultQuota, customQuotas } = req.body;
    const settings = await getSystemSettings();

    // Update default quota
    if (defaultQuota) {
      settings.defaultQuota = parseInt(defaultQuota, 10) || 10;
    }

    // Safely parse and map custom quotas
    const quotaMap = new Map();
    if (customQuotas && typeof customQuotas === 'object') {
      for (const [slot, quotaVal] of Object.entries(customQuotas)) {
        if (quotaVal !== '' && quotaVal !== null && quotaVal !== undefined) {
          const parsedVal = parseInt(quotaVal, 10);
          if (!isNaN(parsedVal)) {
            quotaMap.set(slot, parsedVal);
          }
        }
      }
    }

    settings.customQuotas = quotaMap;
    settings.markModified('customQuotas');

    await settings.save();
    res.redirect('/admin/dashboard');
  } catch (error) {
    console.error('Error saving settings:', error);
    res.status(500).send(`Failed to save settings: ${error.message}`);
  }
});

// 7. Save Drag-and-Drop Slot Order
app.post('/admin/slots/reorder', async (req, res) => {
  try {
    const { orderedSlots } = req.body;
    if (Array.isArray(orderedSlots)) {
      const settings = await getSystemSettings();
      settings.orderedSlots = orderedSlots;
      await settings.save();
      return res.json({ success: true });
    }
    res.status(400).json({ error: 'Invalid slot list' });
  } catch (error) {
    console.error('Error updating slot order:', error);
    res.status(500).json({ error: 'Failed to update order' });
  }
});

// --- Server Startup ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});