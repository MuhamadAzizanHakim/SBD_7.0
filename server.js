SERVER.JS;
require("dotenv").config();
const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const session = require("express-session");
const bcrypt = require("bcrypt");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3003;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "rahasia_super_aman_123",
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 8 * 60 * 60 * 1000 }, // 8 jam
  }),
);

// Sajikan file statis (index.html, login-admin.html, dll) dari folder "public"
app.use(express.static(path.join(__dirname, "public")));

// ─── Koneksi Database ─────────────────────────────────────────────────────────
const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "admin123",
  database: process.env.DB_NAME || "tugas_akhir_sbd",
  port: Number(process.env.DB_PORT) || 3306,
  waitForConnections: true,
  connectionLimit: 10,
});

// ─── Helper ───────────────────────────────────────────────────────────────────
function generateId(prefix) {
  const now = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${prefix}-${now}-${rand}`;
}

function hargaCuci(jenis) {
  return jenis === "Mobil" ? 50000 : 15000;
}

function hargaLogistik(logistik) {
  if (logistik === "Jemput" || logistik === "Antar") return 10000;
  if (logistik === "Antar Jemput") return 20000;
  return 0;
}

function authAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  return res.status(401).json({ error: "Unauthorized. Silakan login admin." });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CUSTOMER API  (dipanggil dari index.html)
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/buat-pesanan
app.post("/api/buat-pesanan", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { nama, wa, plat, model, jenis, logistik } = req.body;

    if (!nama || !wa || !plat || !model || !jenis) {
      return res.status(400).json({ error: "Semua field wajib diisi." });
    }
    if (!["Motor", "Mobil"].includes(jenis)) {
      return res.status(400).json({ error: "Jenis kendaraan tidak valid." });
    }

    const platUpper = plat.toUpperCase().trim();
    const totalCuci = hargaCuci(jenis);
    const totalLog =
      logistik && logistik !== "Langsung" ? hargaLogistik(logistik) : 0;
    const total = totalCuci + totalLog;

    await conn.beginTransaction();

    let [rows] = await conn.query(
      "SELECT id_pelanggan FROM pelanggan WHERE nomor_whatsapp = ? LIMIT 1",
      [wa],
    );

    let id_pelanggan;
    if (rows.length > 0) {
      id_pelanggan = rows[0].id_pelanggan;
      await conn.query(
        "UPDATE pelanggan SET nama_pelanggan = ?, plat_nomor = ? WHERE id_pelanggan = ?",
        [nama, platUpper, id_pelanggan],
      );
    } else {
      id_pelanggan = generateId("PLG");
      await conn.query(
        "INSERT INTO pelanggan (id_pelanggan, nomor_whatsapp, nama_pelanggan, plat_nomor) VALUES (?, ?, ?, ?)",
        [id_pelanggan, wa, nama, platUpper],
      );
    }

    const [kRow] = await conn.query(
      "SELECT plat_nomor FROM kendaraan WHERE plat_nomor = ?",
      [platUpper],
    );
    if (kRow.length === 0) {
      await conn.query(
        "INSERT INTO kendaraan (plat_nomor, id_pelanggan, jenis_kendaraan, nama_model) VALUES (?, ?, ?, ?)",
        [platUpper, id_pelanggan, jenis, model],
      );
    } else {
      await conn.query(
        "UPDATE kendaraan SET id_pelanggan = ?, jenis_kendaraan = ?, nama_model = ? WHERE plat_nomor = ?",
        [id_pelanggan, jenis, model, platUpper],
      );
    }

    const id_transaksi = generateId("TXN");
    const logistikDB = logistik && logistik !== "Langsung" ? logistik : null;

    await conn.query(
      `INSERT INTO pesanan
        (id_transaksi, id_pelanggan, model, jenis, jenis_logistik, total_bayar, status)
       VALUES (?, ?, ?, ?, ?, ?, 'Menunggu')`,
      [id_transaksi, id_pelanggan, model, jenis, logistikDB, total],
    );

    await conn.query(
      `INSERT INTO transaksi
        (id_transaksi, tanggal, id_pelanggan, tipe_kendaraan, jenis_logistik, status_pengerjaan)
       VALUES (?, CURDATE(), ?, ?, ?, 'Menunggu')`,
      [id_transaksi, id_pelanggan, jenis, logistikDB],
    );

    await conn.commit();

    res.json({
      ok: true,
      id_pelanggan,
      id_transaksi,
      total_bayar: total,
      pesan: "Pesanan berhasil dibuat. Menunggu konfirmasi admin.",
    });
  } catch (err) {
    await conn.rollback();
    console.error("[buat-pesanan]", err);
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// GET /api/cek-status/:id_transaksi
app.get("/api/cek-status/:id_transaksi", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT p.id_transaksi, p.status,
              t.status_pengerjaan
       FROM pesanan p
       LEFT JOIN transaksi t ON t.id_transaksi = p.id_transaksi
       WHERE p.id_transaksi = ?`,
      [req.params.id_transaksi],
    );
    if (rows.length === 0)
      return res.status(404).json({ error: "Transaksi tidak ditemukan." });

    const row = rows[0];
    const status = row.status_pengerjaan || row.status;
    res.json({ id_transaksi: row.id_transaksi, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cek-pesanan/:id_pelanggan
app.get("/api/cek-pesanan/:id_pelanggan", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT
         p.id_transaksi,
         p.id_pelanggan,
         pl.nama_pelanggan   AS nama,
         DATE_FORMAT(p.tanggal, '%d/%m/%Y %H:%i') AS tanggal,
         p.jenis,
         p.model,
         p.jenis_logistik    AS logistik,
         p.total_bayar,
         COALESCE(t.status_pengerjaan, p.status) AS status
       FROM pesanan p
       LEFT JOIN pelanggan pl ON pl.id_pelanggan = p.id_pelanggan
       LEFT JOIN transaksi t  ON t.id_transaksi  = p.id_transaksi
       WHERE p.id_pelanggan = ?
       ORDER BY p.tanggal DESC`,
      [req.params.id_pelanggan],
    );
    if (rows.length === 0)
      return res.status(404).json({ error: "Pelanggan tidak ditemukan." });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bayar
app.post("/api/bayar", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { id_transaksi, id_pelanggan, metode, total_bayar } = req.body;
    if (!id_transaksi || !id_pelanggan || !metode || !total_bayar)
      return res.status(400).json({ error: "Data pembayaran tidak lengkap." });
    if (!["CASH", "QRIS"].includes(metode))
      return res.status(400).json({ error: "Metode bayar tidak valid." });

    const [cek] = await conn.query(
      "SELECT status_pengerjaan FROM transaksi WHERE id_transaksi = ?",
      [id_transaksi],
    );
    if (cek.length === 0)
      return res.status(404).json({ error: "Transaksi tidak ditemukan." });
    if (cek[0].status_pengerjaan !== "Dikonfirmasi")
      return res
        .status(400)
        .json({ error: "Pesanan belum dikonfirmasi admin." });

    await conn.beginTransaction();

    await conn.query(
      `INSERT INTO pembayaran (id_transaksi, id_pelanggan, metode_pembayaran, total_bayar)
       VALUES (?, ?, ?, ?)`,
      [id_transaksi, id_pelanggan, metode, total_bayar],
    );

    await conn.query(
      "UPDATE pesanan SET status = 'Dalam Antrean', metode_bayar = ? WHERE id_transaksi = ?",
      [metode, id_transaksi],
    );
    await conn.query(
      "UPDATE transaksi SET status_pengerjaan = 'Dalam Antrean' WHERE id_transaksi = ?",
      [id_transaksi],
    );

    await conn.commit();
    res.json({ ok: true, pesan: "Pembayaran berhasil dicatat." });
  } catch (err) {
    await conn.rollback();
    console.error("[bayar]", err);
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ADMIN AUTH
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/admin/login
app.post("/api/admin/login", async (req, res) => {
  try {
    const { email, kata_sandi } = req.body;
    if (!email || !kata_sandi)
      return res.status(400).json({ error: "Email & kata sandi wajib." });

    const [rows] = await pool.query(
      "SELECT * FROM admin WHERE email = ? LIMIT 1",
      [email],
    );
    if (rows.length === 0)
      return res.status(401).json({ error: "Email tidak ditemukan." });

    const admin = rows[0];
    const cocok = await bcrypt.compare(kata_sandi, admin.kata_sandi);
    if (!cocok) return res.status(401).json({ error: "Kata sandi salah." });

    await pool.query(
      "UPDATE admin SET terakhir_login = NOW() WHERE id_admin = ?",
      [admin.id_admin],
    );

    req.session.admin = {
      id_admin: admin.id_admin,
      email: admin.email,
      peran: admin.peran,
    };

    res.json({
      ok: true,
      admin: {
        id_admin: admin.id_admin,
        email: admin.email,
        peran: admin.peran,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/logout
app.post("/api/admin/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// GET /api/admin/me
app.get("/api/admin/me", authAdmin, (req, res) => {
  res.json({ admin: req.session.admin });
});

// POST /api/admin/seed  — HAPUS setelah production!
app.post("/api/admin/seed", async (req, res) => {
  try {
    const { email, kata_sandi, peran } = req.body;
    if (!email || !kata_sandi)
      return res.status(400).json({ error: "email & kata_sandi wajib." });
    const hash = await bcrypt.hash(kata_sandi, 10);
    await pool.query(
      "INSERT INTO admin (email, kata_sandi, peran) VALUES (?, ?, ?)",
      [email, hash, peran || "Super Admin"],
    );
    res.json({ ok: true, pesan: "Admin berhasil dibuat." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ADMIN API  (semua butuh sesi admin)
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/admin/pesanan?status=Menunggu
app.get("/api/admin/pesanan", authAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    let sql = `
      SELECT
        p.id_transaksi,
        p.id_pelanggan,
        pl.nama_pelanggan,
        pl.nomor_whatsapp,
        DATE_FORMAT(p.tanggal, '%d/%m/%Y %H:%i') AS tanggal,
        p.jenis,
        p.model,
        p.jenis_logistik,
        p.total_bayar,
        p.metode_bayar,
        COALESCE(t.status_pengerjaan, p.status) AS status
      FROM pesanan p
      LEFT JOIN pelanggan pl ON pl.id_pelanggan = p.id_pelanggan
      LEFT JOIN transaksi t  ON t.id_transaksi  = p.id_transaksi
    `;
    const params = [];
    if (status) {
      sql += " WHERE COALESCE(t.status_pengerjaan, p.status) = ?";
      params.push(status);
    }
    sql += " ORDER BY p.tanggal DESC";
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin/pesanan/:id_transaksi/status
app.patch(
  "/api/admin/pesanan/:id_transaksi/status",
  authAdmin,
  async (req, res) => {
    const conn = await pool.getConnection();
    try {
      const { status } = req.body;
      const { id_transaksi } = req.params;

      const statusValid = [
        "Menunggu",
        "Dikonfirmasi",
        "Dalam Antrean",
        "Diproses",
        "Dalam Proses Di Antar",
        "Selesai",
        "Dibatalkan",
      ];
      if (!statusValid.includes(status))
        return res.status(400).json({ error: "Status tidak valid." });

      await conn.beginTransaction();
      await conn.query(
        "UPDATE transaksi SET status_pengerjaan = ? WHERE id_transaksi = ?",
        [status, id_transaksi],
      );
      await conn.query("UPDATE pesanan SET status = ? WHERE id_transaksi = ?", [
        status,
        id_transaksi,
      ]);
      await conn.commit();

      res.json({ ok: true, id_transaksi, status });
    } catch (err) {
      await conn.rollback();
      res.status(500).json({ error: err.message });
    } finally {
      conn.release();
    }
  },
);

// GET /api/admin/pelanggan
app.get("/api/admin/pelanggan", authAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT pl.*, k.jenis_kendaraan, k.nama_model
       FROM pelanggan pl
       LEFT JOIN kendaraan k ON k.plat_nomor = pl.plat_nomor
       ORDER BY pl.id_pelanggan`,
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/pembayaran
app.get("/api/admin/pembayaran", authAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT
         pb.id_transaksi,
         pb.id_pelanggan,
         pl.nama_pelanggan,
         pb.metode_pembayaran,
         pb.total_bayar
       FROM pembayaran pb
       LEFT JOIN pelanggan pl ON pl.id_pelanggan = pb.id_pelanggan
       ORDER BY pb.id_transaksi DESC`,
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/dashboard
app.get("/api/admin/dashboard", authAdmin, async (req, res) => {
  try {
    const [[{ total_pesanan }]] = await pool.query(
      "SELECT COUNT(*) AS total_pesanan FROM pesanan",
    );
    const [[{ total_pelanggan }]] = await pool.query(
      "SELECT COUNT(*) AS total_pelanggan FROM pelanggan",
    );
    const [[{ total_pendapatan }]] = await pool.query(
      "SELECT COALESCE(SUM(total_bayar), 0) AS total_pendapatan FROM pembayaran",
    );
    const [[{ menunggu }]] = await pool.query(
      "SELECT COUNT(*) AS menunggu FROM transaksi WHERE status_pengerjaan = 'Menunggu'",
    );
    const [[{ dikonfirmasi }]] = await pool.query(
      "SELECT COUNT(*) AS dikonfirmasi FROM transaksi WHERE status_pengerjaan = 'Dikonfirmasi'",
    );
    const [[{ selesai }]] = await pool.query(
      "SELECT COUNT(*) AS selesai FROM transaksi WHERE status_pengerjaan = 'Selesai'",
    );

    res.json({
      total_pesanan,
      total_pelanggan,
      total_pendapatan,
      menunggu,
      dikonfirmasi,
      selesai,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/harga-cuci
app.get("/api/admin/harga-cuci", authAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM harga_cuci");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/harga-cuci/:tipe
app.put("/api/admin/harga-cuci/:tipe", authAdmin, async (req, res) => {
  try {
    const { harga } = req.body;
    const tipe = req.params.tipe; // 'Motor' | 'Mobil'
    await pool.query(
      "UPDATE harga_cuci SET harga_cuci = ? WHERE tipe_kendaraan = ?",
      [harga, tipe],
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/tarif-logistik
app.get("/api/admin/tarif-logistik", authAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM tarif_logistik");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ADMIN PANEL API — endpoint yang dipakai oleh admin.html
//  (adapter layer: memetakan format lama admin.html → struktur DB baru)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/orders
 * Mengembalikan semua pesanan dalam format yang diharapkan admin.html:
 * { id, customerName, customerPhone, vehicleType, vehicleModel, vehiclePlate,
 *   logistics, totalPrice, status, timestamp, isNew }
 */
app.get("/api/orders", authAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT
         p.id_transaksi                                        AS id,
         pl.nama_pelanggan                                     AS customerName,
         pl.nomor_whatsapp                                     AS customerPhone,
         p.jenis                                               AS vehicleType,
         p.model                                               AS vehicleModel,
         COALESCE(k.plat_nomor, pl.plat_nomor, '-')           AS vehiclePlate,
         COALESCE(p.jenis_logistik, 'Datang Langsung')        AS logistics,
         p.total_bayar                                         AS totalPrice,
         COALESCE(t.status_pengerjaan, p.status)              AS status,
         DATE_FORMAT(p.tanggal, '%d/%m/%Y %H:%i')             AS timestamp,
         IF(p.tanggal >= NOW() - INTERVAL 10 MINUTE, 1, 0)   AS isNew
       FROM pesanan p
       LEFT JOIN pelanggan pl ON pl.id_pelanggan = p.id_pelanggan
       LEFT JOIN kendaraan  k  ON k.id_pelanggan = p.id_pelanggan
                               AND k.plat_nomor  = pl.plat_nomor
       LEFT JOIN transaksi  t  ON t.id_transaksi  = p.id_transaksi
       ORDER BY p.tanggal DESC`,
    );

    // Normalise nilai logistik agar sesuai label di admin.html
    const statusMap = {
      Menunggu: "Menunggu Konfirmasi",
    };
    const logistikMap = {
      Jemput: "Jemput Saja",
      Antar: "Antar Saja",
      "Antar Jemput": "Paket Lengkap",
    };

    const result = rows.map((r) => ({
      ...r,
      isNew: r.isNew === 1,
      status: statusMap[r.status] || r.status,
      logistics:
        r.logistics === null || r.logistics === "Langsung"
          ? "Datang Langsung"
          : logistikMap[r.logistics] || r.logistics,
    }));

    res.json(result);
  } catch (err) {
    console.error("[GET /api/orders]", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/orders/:id/status
 * Body: { status }  — status dalam format admin.html
 * Memetakan kembali ke nilai DB lalu update kedua tabel.
 */
app.put("/api/orders/:id/status", authAdmin, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { id } = req.params;
    let { status } = req.body;

    // Peta status dari admin.html → nilai DB
    const statusMap = {
      "Menunggu Konfirmasi": "Menunggu",
      "Dalam Antrean": "Dalam Antrean",
      Diproses: "Diproses",
      "Dalam Proses Di Antar": "Dalam Proses Di Antar",
      Selesai: "Selesai",
      Dibatalkan: "Dibatalkan",
    };

    const dbStatus = statusMap[status] ?? status;

    const validStatus = Object.values(statusMap);
    if (!validStatus.includes(dbStatus))
      return res.status(400).json({ error: "Status tidak valid." });

    await conn.beginTransaction();
    await conn.query(
      "UPDATE transaksi SET status_pengerjaan = ? WHERE id_transaksi = ?",
      [dbStatus, id],
    );
    await conn.query("UPDATE pesanan SET status = ? WHERE id_transaksi = ?", [
      dbStatus,
      id,
    ]);
    await conn.commit();

    res.json({ ok: true, id, status: dbStatus });
  } catch (err) {
    await conn.rollback();
    console.error("[PUT /api/orders/:id/status]", err);
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

/**
 * DELETE /api/orders/:id
 * Hapus pesanan dari tabel transaksi & pesanan (cascade atau manual).
 */
app.delete("/api/orders/:id", authAdmin, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { id } = req.params;

    await conn.beginTransaction();
    // Hapus entri pembayaran terkait terlebih dahulu (jika ada FK)
    await conn.query("DELETE FROM pembayaran WHERE id_transaksi = ?", [id]);
    await conn.query("DELETE FROM transaksi WHERE id_transaksi = ?", [id]);
    await conn.query("DELETE FROM pesanan WHERE id_transaksi = ?", [id]);
    await conn.commit();

    res.json({ ok: true, id, pesan: "Pesanan dihapus permanen." });
  } catch (err) {
    await conn.rollback();
    console.error("[DELETE /api/orders/:id]", err);
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

/**
 * GET /api/prices
 * Mengembalikan semua tarif dalam format yang diharapkan admin.html:
 * { mobilBase, motorBase, biayaJemput, biayaAntar, biayaPaket }
 */
app.get("/api/prices", authAdmin, async (req, res) => {
  try {
    // Ambil harga cuci
    const [hargaRows] = await pool.query("SELECT * FROM harga_cuci");
    // Ambil tarif logistik
    const [logRows] = await pool.query("SELECT * FROM tarif_logistik");

    // Normalisasi — sesuaikan nama kolom dengan skema tabel kamu
    const mobilRow = hargaRows.find((r) => r.tipe_kendaraan === "Mobil");
    const motorRow = hargaRows.find((r) => r.tipe_kendaraan === "Motor");
    const jemputRow = logRows.find(
      (r) =>
        (r.jenis_logistik || r.tipe_logistik || "").toLowerCase() === "jemput",
    );
    const antarRow = logRows.find(
      (r) =>
        (r.jenis_logistik || r.tipe_logistik || "").toLowerCase() === "antar",
    );
    const paketRow = logRows.find((r) =>
      ["antar jemput", "paket", "paket lengkap"].includes(
        (r.jenis_logistik || r.tipe_logistik || "").toLowerCase(),
      ),
    );

    res.json({
      mobilBase: mobilRow
        ? Number(mobilRow.harga_cuci ?? mobilRow.harga ?? 0)
        : 0,
      motorBase: motorRow
        ? Number(motorRow.harga_cuci ?? motorRow.harga ?? 0)
        : 0,
      biayaJemput: jemputRow
        ? Number(jemputRow.harga_logistik ?? jemputRow.harga ?? 0)
        : 0,
      biayaAntar: antarRow
        ? Number(antarRow.harga_logistik ?? antarRow.harga ?? 0)
        : 0,
      biayaPaket: paketRow
        ? Number(paketRow.harga_logistik ?? paketRow.harga ?? 0)
        : 0,
    });
  } catch (err) {
    console.error("[GET /api/prices]", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/prices
 * Body: { mobilBase, motorBase, biayaJemput, biayaAntar, biayaPaket }
 * Update harga_cuci & tarif_logistik sekaligus.
 */
app.put("/api/prices", authAdmin, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { mobilBase, motorBase, biayaJemput, biayaAntar, biayaPaket } =
      req.body;

    await conn.beginTransaction();

    // Update harga cuci
    await conn.query(
      "UPDATE harga_cuci SET harga_cuci = ? WHERE tipe_kendaraan = 'Mobil'",
      [mobilBase ?? 0],
    );
    await conn.query(
      "UPDATE harga_cuci SET harga_cuci = ? WHERE tipe_kendaraan = 'Motor'",
      [motorBase ?? 0],
    );

    // Update tarif logistik — coba kedua nama kolom yang mungkin ada
    // Gunakan INSERT … ON DUPLICATE KEY UPDATE agar tidak gagal jika baris belum ada
    const logistikUpdates = [
      { jenis: "Jemput", harga: biayaJemput ?? 0 },
      { jenis: "Antar", harga: biayaAntar ?? 0 },
      { jenis: "Antar Jemput", harga: biayaPaket ?? 0 },
    ];

    for (const item of logistikUpdates) {
      // Coba update terlebih dahulu; jika 0 baris terpengaruh → insert
      const colName = await getLogistikColName(conn);
      const [upd] = await conn.query(
        `UPDATE tarif_logistik SET harga_logistik = ? WHERE ${colName} = ?`,
        [item.harga, item.jenis],
      );
      if (upd.affectedRows === 0) {
        // Baris belum ada, insert baru
        await conn.query(
          `INSERT INTO tarif_logistik (${colName}, harga_logistik) VALUES (?, ?)`,
          [item.jenis, item.harga],
        );
      }
    }

    await conn.commit();
    res.json({ ok: true, pesan: "Tarif berhasil diperbarui." });
  } catch (err) {
    await conn.rollback();
    console.error("[PUT /api/prices]", err);
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// ─── Util: deteksi nama kolom jenis di tarif_logistik ────────────────────────
let _logistikColCache = null;
async function getLogistikColName(conn) {
  if (_logistikColCache) return _logistikColCache;
  const [cols] = await conn.query("SHOW COLUMNS FROM tarif_logistik");
  const names = cols.map((c) => c.Field.toLowerCase());
  _logistikColCache = names.includes("jenis_logistik")
    ? "jenis_logistik"
    : "tipe_logistik";
  return _logistikColCache;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  FALLBACK — kirim index.html untuk semua route non-API
// ═══════════════════════════════════════════════════════════════════════════════
app.get("*", (req, res) => {
  if (!req.path.startsWith("/api")) {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅  CucianUNP server berjalan di http://localhost:${PORT}`);
});
