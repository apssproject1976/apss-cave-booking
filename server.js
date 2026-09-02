require('dotenv').config(); // Load environment variables from .env

const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer Storage Configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${file.fieldname}-${Date.now()}${ext}`);
  }
});
const upload = multer({ storage });

// Multer multi-field upload configuration
const uploadFields = upload.fields([
  { name: 'logo', maxCount: 1 },
  { name: 'bgImage', maxCount: 1 }
]);

// Middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// MongoDB Connection (Loads MONGODB_URI directly from .env)
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/cave_booking';
mongoose.connect(MONGODB_URI)
  .then(() => console.log('MongoDB connected successfully'))
  .catch(err => console.error('MongoDB connection error:', err));

// MongoDB Schemas & Models
const bookingSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true },
  phone: { type: String, default: '' },
  timeSlot: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

// Generator function for 10-minute slots (4 per hour with 5-min buffers)
function generate10MinSlots() {
  const slots = [];
  const hours = [10, 11, 12, 13, 14, 15, 16]; // 10:00 AM to 4:30 PM

  hours.forEach(hour => {
    const period = hour >= 12 ? 'PM' : 'AM';
    const displayHour = hour > 12 ? hour - 12 : hour;
    const pad = (n) => String(n).padStart(2, '0');

    // 4 sessions per hour: :00-:10, :15-:25, :30-:40, :45-:55
    const intervals = [
      { startM: 0,  endM: 10 },
      { startM: 15, endM: 25 },
      { startM: 30, endM: 40 },
      { startM: 45, endM: 55 }
    ];

    for (const { startM, endM } of intervals) {
      // Cut off at 4:30 PM (16:30)
      if (hour === 16 && startM >= 30) break;

      const startTime = `${pad(displayHour)}:${pad(startM)} ${period}`;
      const endTime = `${pad(displayHour)}:${pad(endM)} ${period}`;
      slots.push(`${startTime} - ${endTime}`);
    }
  });

  return slots;
}

const settingsSchema = new mongoose.Schema({
  title: { type: String, default: 'APSS Cave Experience Booking System' },
  logoUrl: { type: String, default: '' },
  bgImageUrl: { type: String, default: '' },
  defaultQuota: { type: Number, default: 10 },
  customQuotas: { type: Map, of: Number, default: {} },
  slots: {
    type: [String],
    default: generate10MinSlots
  }
});

const Booking = mongoose.model('Booking', bookingSchema);
const Settings = mongoose.model('Settings', settingsSchema);

// Helper to retrieve single Settings document
async function getSettings() {
  let settings = await Settings.findOne();
  if (!settings) {
    settings = await Settings.create({});
  }
  return settings;
}

// ==========================================
// PUBLIC USER ROUTES
// ==========================================

// GET / - Public Booking Page
app.get('/', async (req, res) => {
  try {
    const settings = await getSettings();
    const bookings = await Booking.find({});

    // Count existing reservations per slot
    const slotCounts = {};
    bookings.forEach(b => {
      slotCounts[b.timeSlot] = (slotCounts[b.timeSlot] || 0) + 1;
    });

    // Calculate dynamic available capacities
    const slotData = settings.slots.map(slot => {
      const capacity = (settings.customQuotas && settings.customQuotas.has(slot))
        ? settings.customQuotas.get(slot)
        : settings.defaultQuota;
      const booked = slotCounts[slot] || 0;
      return {
        name: slot,
        capacity,
        booked,
        available: Math.max(0, capacity - booked)
      };
    });

    res.render('index', {
      settings,
      slotData,
      success: req.query.success === '1'
    });
  } catch (err) {
    console.error('Error loading booking page:', err);
    res.status(500).send('Server Error');
  }
});

// POST /booking - Create Reservation
app.post('/booking', async (req, res) => {
  try {
    const { name, email, phone, timeSlot } = req.body;
    const settings = await getSettings();

    const capacity = (settings.customQuotas && settings.customQuotas.has(timeSlot))
      ? settings.customQuotas.get(timeSlot)
      : settings.defaultQuota;

    const currentCount = await Booking.countDocuments({ timeSlot });

    if (currentCount >= capacity) {
      return res.status(400).send('Selected time slot is fully booked.');
    }

    await Booking.create({ name, email, phone, timeSlot });
    res.redirect('/?success=1');
  } catch (err) {
    console.error('Error creating booking:', err);
    res.status(500).send('Failed to complete booking.');
  }
});

// ==========================================
// ADMIN ROUTES
// ==========================================

// GET /admin/dashboard - Admin Interface
app.get('/admin/dashboard', async (req, res) => {
  try {
    const settings = await getSettings();
    const bookings = await Booking.find({}).sort({ createdAt: -1 });

    res.render('admin-dashboard', {
      settings,
      slots: settings.slots,
      bookings
    });
  } catch (err) {
    console.error('Error loading admin dashboard:', err);
    res.status(500).send('Server Error');
  }
});

// POST /admin/settings - Update Settings, Logo & Background Image
app.post('/admin/settings', uploadFields, async (req, res) => {
  try {
    const { title, defaultQuota, customQuotas } = req.body;
    const settings = await getSettings();

    settings.title = title || settings.title;
    settings.defaultQuota = parseInt(defaultQuota, 10) || settings.defaultQuota;

    // Handle file uploads
    if (req.files) {
      if (req.files.logo && req.files.logo[0]) {
        settings.logoUrl = `/uploads/${req.files.logo[0].filename}`;
      }
      if (req.files.bgImage && req.files.bgImage[0]) {
        settings.bgImageUrl = `/uploads/${req.files.bgImage[0].filename}`;
      }
    }

    // Process custom slot quotas map
    const newCustomQuotas = new Map();
    if (customQuotas && typeof customQuotas === 'object') {
      Object.keys(customQuotas).forEach(slot => {
        const val = customQuotas[slot];
        if (val !== '' && val !== null && !isNaN(val)) {
          newCustomQuotas.set(slot, parseInt(val, 10));
        }
      });
    }
    settings.customQuotas = newCustomQuotas;

    await settings.save();
    res.redirect('/admin/dashboard');
  } catch (err) {
    console.error('Error updating settings:', err);
    res.status(500).send('Failed to update system settings.');
  }
});

// POST /admin/slots/reorder - Drag-and-Drop Reorder API Endpoint
app.post('/admin/slots/reorder', async (req, res) => {
  try {
    const { orderedSlots } = req.body;
    if (!Array.isArray(orderedSlots)) {
      return res.status(400).json({ error: 'Invalid slot ordering data.' });
    }

    const settings = await getSettings();
    settings.slots = orderedSlots;
    await settings.save();

    res.json({ success: true });
  } catch (err) {
    console.error('Error reordering slots:', err);
    res.status(500).json({ error: 'Failed to reorder slots.' });
  }
});

// POST /admin/bookings/delete/:id - Delete Single Reservation Entry
app.post('/admin/bookings/delete/:id', async (req, res) => {
  try {
    await Booking.findByIdAndDelete(req.params.id);
    res.redirect('/admin/dashboard');
  } catch (err) {
    console.error('Error deleting booking:', err);
    res.status(500).send('Failed to delete reservation entry.');
  }
});

// GET /admin/bookings/export-csv - CSV Export Endpoint
app.get('/admin/bookings/export-csv', async (req, res) => {
  try {
    const bookings = await Booking.find({}).sort({ createdAt: -1 });

    const headers = ['Booking ID', 'Created Date', 'Time Slot', 'Name', 'Email', 'Phone'];

    const sanitize = (val) => {
      if (val === null || val === undefined) return '""';
      const str = String(val).replace(/"/g, '""');
      return `"${str}"`;
    };

    const rows = bookings.map(b => [
      sanitize(b._id),
      sanitize(new Date(b.createdAt).toISOString()),
      sanitize(b.timeSlot),
      sanitize(b.name),
      sanitize(b.email),
      sanitize(b.phone || '')
    ].join(','));

    const csvContent = [headers.join(','), ...rows].join('\n');

    const filename = `reservations-export-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // Prepend UTF-8 BOM for Excel compatibility
    res.status(200).send('\uFEFF' + csvContent);
  } catch (err) {
    console.error('Error exporting CSV:', err);
    res.status(500).send('Failed to export CSV data.');
  }
});

// GET /admin/logout - Basic Logout Redirection
app.get('/admin/logout', (req, res) => {
  res.redirect('/');
});

// Start Express Server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
