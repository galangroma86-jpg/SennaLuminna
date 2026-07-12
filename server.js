require('dotenv').config();
const express = require('express');
const cors = require('cors');
const midtransClient = require('midtrans-client');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ORDERS_FILE = path.join(__dirname, 'orders.json');
if (!fs.existsSync(ORDERS_FILE)) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify([], null, 2));
}

function readOrders() {
  return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf-8'));
}

function saveOrders(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

const snap = new midtransClient.Snap({
  isProduction: process.env.IS_PRODUCTION === 'true',
  serverKey: process.env.MIDTRANS_SERVER_KEY,
  clientKey: process.env.MIDTRANS_CLIENT_KEY
});

// Kirim client key ke frontend supaya popup Snap bisa dimuat
app.get('/api/config', (req, res) => {
  res.json({ clientKey: process.env.MIDTRANS_CLIENT_KEY });
});

// Buat transaksi baru -> hasilkan token pembayaran Snap
app.post('/api/create-transaction', async (req, res) => {
  try {
    const { items, customer } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'Keranjang kosong.' });
    }
    if (!customer || !customer.name || !customer.phone || !customer.address) {
      return res.status(400).json({ error: 'Data pelanggan belum lengkap.' });
    }

    const grossAmount = items.reduce((sum, it) => sum + it.price * it.qty, 0);
    const orderId = 'SL-' + Date.now();

    const parameter = {
      transaction_details: {
        order_id: orderId,
        gross_amount: grossAmount
      },
      item_details: items.map(it => ({
        id: String(it.id),
        price: it.price,
        quantity: it.qty,
        name: it.name.substring(0, 50)
      })),
      customer_details: {
        first_name: customer.name,
        phone: customer.phone,
        shipping_address: {
          address: customer.address
        }
      }
    };

    const transaction = await snap.createTransaction(parameter);

    const orders = readOrders();
    orders.push({
      order_id: orderId,
      customer,
      items,
      gross_amount: grossAmount,
      status: 'pending',
      created_at: new Date().toISOString()
    });
    saveOrders(orders);

    res.json({ token: transaction.token, order_id: orderId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Gagal membuat transaksi. Coba lagi.' });
  }
});

// Webhook: Midtrans akan memanggil URL ini otomatis setiap status pembayaran berubah
app.post('/api/midtrans-notification', async (req, res) => {
  try {
    const statusResponse = await snap.transaction.notification(req.body);
    const orderId = statusResponse.order_id;
    const transactionStatus = statusResponse.transaction_status;
    const fraudStatus = statusResponse.fraud_status;

    let newStatus = 'pending';
    if (transactionStatus === 'capture' || transactionStatus === 'settlement') {
      newStatus = (fraudStatus === 'accept' || !fraudStatus) ? 'paid' : 'challenge';
    } else if (transactionStatus === 'cancel' || transactionStatus === 'deny' || transactionStatus === 'expire') {
      newStatus = 'failed';
    } else if (transactionStatus === 'pending') {
      newStatus = 'pending';
    }

    const orders = readOrders();
    const idx = orders.findIndex(o => o.order_id === orderId);
    if (idx !== -1) {
      orders[idx].status = newStatus;
      orders[idx].updated_at = new Date().toISOString();
      saveOrders(orders);
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error');
  }
});

// Lihat semua pesanan (dasar untuk admin sederhana)
app.get('/api/orders', (req, res) => {
  res.json(readOrders());
});

// Cek status satu pesanan (dipakai frontend setelah pembayaran)
app.get('/api/orders/:orderId', (req, res) => {
  const orders = readOrders();
  const order = orders.find(o => o.order_id === req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan.' });
  res.json(order);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server jalan di http://localhost:${PORT}`);
});
