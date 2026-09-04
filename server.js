const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const basicAuth = require('express-basic-auth');
require('dotenv').config();

const app = express();

// --- Middleware Setup ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

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
  logoUrl: { type: String, default: '' },
  logoWidth: { type: Number, default: 120 },
  bgImageUrl: { type: String, default: '' },
  defaultQuota: { type: Number, default: 10 },
  customQuotas: { type: Map, of: Number, default: {} },
  orderedSlots: { type: [String], default: [] }
});

const Booking = mongoose.model('Booking', bookingSchema);
const Setting = mongoose.model('Setting', settingSchema);

// --- Helper: Generate 10-Min Session Slots ---
function generateDefaultSlots() {
  const slots = [];
  const startHour = 10;
  const endHour = 16;

  for (let hour = startHour; hour <= endHour; hour++) {
    const displayHour = hour > 12 ? hour - 12 : hour;
    const formattedHour = String(displayHour).padStart(2, '0');
    const period = hour >= 12 ? 'p.m.' : 'a.m.';

    const intervals = [
      { start: '00', end: '10' },
      { start: '15', end: '25' },
      { start: '30', end: '40' },
      { start: '45', end: '55' }
    ];

    for (const interval of intervals) {
      if (hour === 16 && parseInt(interval.start, 10) >= 30) break;
      slots.push(`${formattedHour}:${interval.start} ${period} - ${formattedHour}:${interval.end} ${period}`);
    }
  }
  return slots;
}

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

// --- Helper: Get Booking Counts per Slot ---
async function getSlotCounts() {
  const counts = await Booking.aggregate([
    { $group: { _id: '$timeSlot', count: { $sum: 1 } } }
  ]);
  const slotCounts = {};
  counts.forEach(item => {
    if (item._id) {
      slotCounts[item._id] = item.count;
    }
  });
  return slotCounts;
}

// --- Public Routes ---

// 1. Home / Booking Page
app.get('/', async (req, res) => {
  try {
    const settings = await getSystemSettings();
    const slotCounts = await getSlotCounts();

    res.render('index', { 
      slots: settings.orderedSlots, 
      settings,
      slotCounts,
      success: false,
      error: null,
      booking: null
    });
  } catch (error) {
    console.error('Error rendering homepage:', error);
    res.status(500).send('Server Error');
  }
});

// 2. Submit Booking Route
app.post('/book', async (req, res) => {
  try {
    const { name, email, phone, timeSlot } = req.body;
    const settings = await getSystemSettings();
    const currentCount = await Booking.countDocuments({ timeSlot });

    // Determine effective capacity for selected slot
    const capacity = (settings.customQuotas && settings.customQuotas.has(timeSlot))
      ? settings.customQuotas.get(timeSlot)
      : settings.defaultQuota;

    // Guardrail against overbooking
    if (currentCount >= capacity) {
      const slotCounts = await getSlotCounts();
      return res.status(400).render('index', {
        slots: settings.orderedSlots,
        settings,
        slotCounts,
        success: false,
        error: 'The selected time slot is already full. Please pick another slot.',
        booking: null
      });
    }

    const newBooking = new Booking({ name, email, phone, timeSlot });
    await newBooking.save();

    const slotCounts = await getSlotCounts();
    res.render('index', { 
      slots: settings.orderedSlots,
      settings,
      slotCounts,
      success: true,
      error: null,
      booking: newBooking
    });
  } catch (error) {
    console.error('Error creating booking:', error);
    res.status(500).send('Failed to process booking. Please try again.');
  }
});

// --- View-Only Authentication & Route ---
const viewAuth = basicAuth({
  users: { 
    [process.env.VIEW_USER || 'viewer']: process.env.VIEW_PASS || 'view2026pass' 
  },
  challenge: true,
  realm: 'APSS Cave View-Only Area'
});

app.get('/view/dashboard', viewAuth, async (req, res) => {
  try {
    const bookings = await Booking.find({}).sort({ createdAt: -1 }).lean();
    const settings = await getSystemSettings();

    res.render('view-dashboard', {
      bookings,
      settings,
      slots: settings.orderedSlots
    });
  } catch (error) {
    console.error('Error rendering view dashboard:', error);
    res.status(500).send('Error loading dashboard');
  }
});

// --- Admin Authentication Middleware ---
app.use('/admin', basicAuth({
  users: { 
    [process.env.ADMIN_USER || 'admin']: process.env.ADMIN_PASS || 'cave2026pass' 
  },
  challenge: true,
  realm: 'APSS Cave Admin Area'
}));

// --- Admin Routes ---

app.get('/admin', (req, res) => {
  res.redirect('/admin/dashboard');
});

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

app.post('/admin/bookings/delete/:id', async (req, res) => {
  try {
    await Booking.findByIdAndDelete(req.params.id);
    res.redirect('/admin/dashboard');
  } catch (error) {
    console.error('Error deleting booking:', error);
    res.status(500).send('Failed to delete entry');
  }
});

// Save System Settings (Title, Logo, Background, Quotas)
app.post('/admin/settings', async (req, res) => {
  try {
    const { title, logoUrl, logoWidth, bgImageUrl, defaultQuota, customQuotas } = req.body;
    const settings = await getSystemSettings();

    if (title !== undefined) settings.title = title || 'APSS Cave Experience';
    if (logoUrl !== undefined) settings.logoUrl = logoUrl.trim();
    if (logoWidth !== undefined) settings.logoWidth = parseInt(logoWidth, 10) || 120;
    if (bgImageUrl !== undefined) settings.bgImageUrl = bgImageUrl.trim();

    if (defaultQuota) {
      settings.defaultQuota = parseInt(defaultQuota, 10) || 10;
    }

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});