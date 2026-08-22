import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import superAmazonLogo from "./assets/super-amazon-logo.png";

const API =
  import.meta.env.VITE_API_URL || "http://localhost:4000/api";

const meta = {
  MEMBER: ["عضو", "◉"],
  ADMIN: ["ادمن", "◆"],
  BROKER: ["وسيط", "▣"],
  OWNER: ["OWNER", "♛"],
  OWNER_ASSISTANT: ["مساعد Owner", "◇"],
};

function accountLabel(value) {
  return ({ ADMIN: "ادمن", BROKER: "وسيط", MEMBER: "عضو" })[value] || value || "—";
}

async function api(path, options = {}) {
  const token = localStorage.getItem("sa_token");

  const headers = {
    ...(options.headers || {}),
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  // لا نضع Content-Type مع FormData حتى يضيف المتصفح boundary تلقائيًا.
  if (
    options.body &&
    !(options.body instanceof FormData)
  ) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(API + path, {
    ...options,
    headers,
  });

  const data = await response.json().catch(() => ({
    message: "استجابة غير صالحة من الخادم",
  }));

  if (!response.ok) {
    throw new Error(
      data.message || data.error || "حدث خطأ في الطلب"
    );
  }

  return data;
}

function readTelegramRedirectToken() {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const token = params.get("telegram_token");
  if (token) {
    localStorage.setItem("sa_token", token);
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  return token || localStorage.getItem("sa_token");
}

function App() {
  const [user, setUser] = useState(
    JSON.parse(localStorage.getItem("sa_user") || "null")
  );

  const [token, setToken] = useState(readTelegramRedirectToken);

  const [page, setPage] = useState("home");
  const [dark, setDark] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 700);
  const [authError, setAuthError] = useState("");
  const [authenticating, setAuthenticating] = useState(false);
  const [authStatus, setAuthStatus] = useState("بانتظار تأكيد Telegram.");

  useEffect(() => {
    const webApp = window.Telegram?.WebApp;
    const initData = webApp?.initData;

    if (!token && initData) {
      webApp.ready();
      webApp.expand();
      setAuthenticating(true);
      setAuthStatus("جاري التحقق من حساب Telegram...");
      api("/auth/telegram/webapp", {
        method: "POST",
        body: JSON.stringify({ initData }),
      })
        .then((result) => {
          localStorage.setItem("sa_token", result.token);
          localStorage.setItem("sa_user", JSON.stringify(result.user));
          setToken(result.token);
          setUser(result.user);
          setAuthStatus("تم تسجيل الدخول بنجاح.");
        })
        .catch((error) => {
          setAuthError(error.message || "تعذر إكمال تسجيل Telegram");
          setAuthStatus("تعذر إنشاء الجلسة.");
        })
        .finally(() => setAuthenticating(false));
      return;
    }

    const query = new URLSearchParams(window.location.search);
    const code = query.get("code");
    const state = query.get("state");

    if (code && state) {
      setAuthenticating(true);
      setAuthStatus("جاري التحقق من رد Telegram...");
      api("/auth/telegram/exchange", {
        method: "POST",
        body: JSON.stringify({ code, state }),
      })
        .then((result) => {
          localStorage.setItem("sa_token", result.token);
          localStorage.setItem("sa_user", JSON.stringify(result.user));
          window.history.replaceState(null, "", window.location.pathname);
          setToken(result.token);
          setUser(result.user);
          setAuthStatus("تم تسجيل الدخول بنجاح.");
        })
        .catch((error) => {
          setAuthError(error.message || "تعذر إكمال تسجيل Telegram");
          setAuthStatus("تعذر إنشاء الجلسة بعد عودة Telegram.");
        })
        .finally(() => setAuthenticating(false));
      return;
    }

    if (!token) return;

    api("/auth/me")
      .then((result) => {
        localStorage.setItem("sa_user", JSON.stringify(result.user));
        setUser(result.user);
      })
      .catch(() => logout());
  }, []);

  useEffect(() => {
    const closeOnMobileResize = () => {
      setSidebarOpen(window.innerWidth > 700);
    };
    window.addEventListener("resize", closeOnMobileResize);
    return () => window.removeEventListener("resize", closeOnMobileResize);
  }, []);

  async function login(telegramPayload) {
    if (!telegramPayload?.id_token && !telegramPayload?.hash) {
      setAuthError("لم تصل بيانات المصادقة من Telegram. أعد المحاولة من الزر الظاهر أدناه.");
      setAuthStatus("لم تصل بيانات مصادقة من Telegram.");
      return;
    }

    setAuthenticating(true);
    setAuthError("");
    setAuthStatus("تم استلام بيانات Telegram، جاري إنشاء الجلسة...");
    try {
      const result = await api("/auth/telegram", {
        method: "POST",
        body: JSON.stringify(telegramPayload),
      });

      localStorage.setItem("sa_token", result.token);
      localStorage.setItem(
        "sa_user",
        JSON.stringify(result.user)
      );

      setToken(result.token);
      setUser(result.user);
      setAuthStatus("تم تسجيل الدخول بنجاح.");
    } catch (error) {
      setAuthError(error.message || "تعذر إكمال تسجيل الدخول");
      setAuthStatus("رفض الخادم إنشاء الجلسة.");
    } finally {
      setAuthenticating(false);
    }
  }

  async function logout() {
    try {
      if (localStorage.getItem("sa_token")) {
        await api("/auth/logout", { method: "POST" });
      }
    } catch {
      // يُحذف الرمز محليًا حتى عند تعذر الاتصال بالخادم.
    }
    localStorage.removeItem("sa_token");
    localStorage.removeItem("sa_user");
    setToken(null);
    setUser(null);
    setPage("home");
  }

  if (!token || !user) {
    return (
      <Login login={login} error={authError} loading={authenticating} status={authStatus} />
    );
  }

  const role =
    user.role === "OWNER" ||
    user.role === "OWNER_ASSISTANT"
      ? user.role
      : user.account_type;

  return (
    <div className={`${dark ? "shell dark" : "shell"} ${sidebarOpen ? "sidebar-open" : "sidebar-collapsed"}`}>
      <Side
        role={role}
        page={page}
        setPage={setPage}
        logout={logout}
        open={sidebarOpen}
        onNavigate={() => { if (window.innerWidth <= 700) setSidebarOpen(false); }}
      />
      <button className="sidebar-overlay" aria-label="إغلاق القائمة" onClick={() => setSidebarOpen(false)} />

      <main>
        <header>
          <div>
            <button className="menu-toggle" aria-label={sidebarOpen ? "تصغير القائمة" : "إظهار القائمة"} aria-expanded={sidebarOpen} onClick={() => setSidebarOpen((current) => !current)}>☰</button>
            <small>Super Amazon / لوحة التحكم</small>
            <h1>
              مرحبًا، <bdi className="unicode-text">{user.telegram_name || "بك"}</bdi> 👋
            </h1>
          </div>

          <div>
            <button
              className="icon"
              onClick={() => setDark(!dark)}
              title="الوضع الليلي"
            >
              ☾
            </button>

            <span className="user">
              {meta[role]?.[0] || role}
            </span>
          </div>
        </header>

        <Router
          role={role}
          page={page}
          user={user}
          setPage={setPage}
          dark={dark}
          setDark={setDark}
        />
      </main>
    </div>
  );
}

function Login({ login, error, loading, status }) {
  return (
    <div className="login">
      <section className="brand">
        <img
          className="brand-logo login-logo"
          src={superAmazonLogo}
          alt="Super Amazon"
          style={{ width: 82, height: 82, objectFit: "cover", borderRadius: 22, border: "1px solid #f7c451", boxShadow: "0 6px 18px #00000055", marginBottom: 10 }}
        />
        <small>PLATFORM • 2026</small>

        <h1>
          SUPER
          <br />
          <span>AMAZON</span>
        </h1>

        <p>
          منصة موحدة للأعضاء والادمن والوسطاء
          بإدارة Owner مركزية وآمنة.
        </p>

        <p>◈ هوية Telegram</p>
        <p>◈ طلبات تحقق ومراجعة</p>
        <p>◈ مالية وشكاوى وإشعارات</p>
      </section>

      <section className="loginbox">
        <small>● بوابة الدخول</small>

        <h2>ابدأ من Telegram</h2>

        <p>يتم إنشاء حساب عضو بعد تأكيد هويتك، ثم يمكنك تقديم طلب ترقية إلى ادمن أو وسيط.</p>

        <TelegramLogin login={login} loading={loading} />
        <small className="auth-status">الحالة: {status}</small>
        {error && <p className="error">تعذر تسجيل الدخول: {error}</p>}

        <footer>
          المطور{" "}
          <a
            href="https://t.me/R_M_D"
            target="_blank"
            rel="noreferrer"
          >
            @R_M_D
          </a>
        </footer>
      </section>
    </div>
  );
}

function TelegramLogin({ loading }) {
  function openLogin() {
    const returnUrl = encodeURIComponent(window.location.origin);
    window.location.assign(`/api/auth/telegram/start?returnUrl=${returnUrl}`);
  }

  return (
    <button className="telegram" disabled={loading} onClick={openLogin}>
      {loading ? "جاري إنشاء الجلسة..." : "تسجيل الدخول عبر Telegram"}
    </button>
  );
}

function Side({
  role,
  page,
  setPage,
  logout,
  open,
  onNavigate,
}) {
  const items = [
    ["home", "الرئيسية", "⌂"],
  ];

  if (role === "MEMBER") {
    items.push([
      "application",
      "طلب ادمن أو وسيط",
      "▣",
    ], [
      "complaints",
      "الشكاوى",
      "⚑",
    ]);
  }

  if (role === "ADMIN") {
    items.push([
      "application",
      "حالة الطلب",
      "▣",
    ], [
      "complaints",
      "الشكاوى",
      "⚑",
    ]);
  }

  if (role === "BROKER") {
    items.push(
      ["application", "حالة الطلب", "▣"],
      ["finance", "المالية", "₿"],
      ["payments", "الدفعات", "↗"],
      ["receipts", "الإيصالات", "▧"],
      ["complaints", "الشكاوى", "⚑"]
    );
  }

  if (
    role === "OWNER" ||
    role === "OWNER_ASSISTANT"
  ) {
    items.push(
      ["users", "المستخدمون", "♟"],
      ["requests", "الطلبات", "✓"],
      ["complaints", "الشكاوى", "⚑"],
      ["finance", "مالية الوسطاء", "₿"],
      ["reports", "التقارير", "▥"],
      [
        "assistants",
        "المساعدون والصلاحيات",
        "◇",
      ],
      ["audit", "سجل العمليات", "◌"],
      ["backup", "النسخ الاحتياطي", "↻"],
      ["system", "حالة النظام", "▦"]
    );
  }

  items.push(
    ["notifications", "الإشعارات", "◉"],
    ["rules", "القوانين والتوجيهات", "▤"],
    ["profile", "ملفي الشخصي", "◎"],
    ["settings", "الإعدادات", "⚙"]
  );

  return (
    <aside className={open ? "sidebar expanded" : "sidebar collapsed"} aria-label="التنقل الرئيسي">
      <div className="logo">
        <img
          className="brand-logo sidebar-logo"
          src={superAmazonLogo}
          alt="Super Amazon"
          style={{ width: 43, height: 43, objectFit: "cover", borderRadius: 12, border: "1px solid #f7c451", boxShadow: "0 6px 18px #00000055", flex: "0 0 43px" }}
        />

        <span>
          SUPER AMAZON
          <small>CONTROL PLATFORM</small>
        </span>
      </div>

      {items.map((item) => (
        <button
          key={item[0]}
          className={
            page === item[0]
              ? "nav active"
              : "nav"
          }
          onClick={() => setPage(item[0])}
          onClickCapture={onNavigate}
          title={item[1]}
        >
          {item[2]}
          <span>{item[1]}</span>
        </button>
      ))}

      <div className="bottom">
        <a
          href="https://t.me/R_M_D"
          target="_blank"
          rel="noreferrer"
        >
          ↗ تواصل مع المطور
          <br />
          <small>@R_M_D</small>
        </a>

        <button onClick={logout} title="تسجيل الخروج">
          ⇦ تسجيل الخروج
        </button>
      </div>
    </aside>
  );
}

function Router({
  role,
  page,
  user,
  setPage,
  dark,
  setDark,
}) {
  if (page === "home") {
    return (
      <Home
        role={role}
        user={user}
        setPage={setPage}
      />
    );
  }

  if (page === "application") {
    return <Application user={user} />;
  }

  if (page === "complaints") {
    return <Complaints role={role} />;
  }

  if (page === "notifications") {
    return <Notifications />;
  }

  if (page === "rules") {
    return <Announcements role={role} />;
  }

  if (page === "finance") {
    return <Finance role={role} />;
  }

  if (page === "payments") {
    return role === "BROKER" ? <BrokerLedger mode="payments" /> : <Basic title="الدفعات" icon="↗" />;
  }

  if (page === "receipts") {
    return role === "BROKER" ? <BrokerLedger mode="receipts" /> : <Basic title="الإيصالات" icon="▧" />;
  }

  if (page === "users") {
    return <Users />;
  }

  if (page === "requests") {
    return <Requests />;
  }

  if (page === "reports") {
    return <OwnerReports />;
  }

  if (page === "assistants") {
    return <Assistants role={role} />;
  }

  if (page === "audit") {
    return <AuditLog />;
  }

  if (page === "backup") {
    return <Backup role={role} />;
  }

  if (page === "system") {
    return <SystemStatus />;
  }

  if (page === "profile") {
    return <Profile user={user} />;
  }

  if (page === "settings") {
    return <Settings dark={dark} setDark={setDark} user={user} />;
  }

  return (
    <Basic
      title={
        page === "notifications"
          ? "الإشعارات"
          : page === "rules"
          ? "القوانين والتوجيهات"
          : "الإعدادات"
      }
      icon={
        page === "notifications"
          ? "◉"
          : page === "rules"
          ? "▤"
          : "⚙"
      }
    />
  );
}

function Title({ t, d, i }) {
  return (
    <div className="title">
      <b>{i}</b>

      <div>
        <h2>{t}</h2>
        <p>{d}</p>
      </div>
    </div>
  );
}

function Home({
  role,
  user,
  setPage,
}) {
  const owner =
    role === "OWNER" ||
    role === "OWNER_ASSISTANT";

  const [ownerDashboard, setOwnerDashboard] = useState(null);
  const [accountDashboard, setAccountDashboard] = useState(null);
  const [brokerFinance, setBrokerFinance] = useState(null);

  useEffect(() => {
    if (!owner) return;
    api("/owner/dashboard").then((result) => setOwnerDashboard(result.dashboard)).catch(() => {});
  }, [owner]);

  useEffect(() => {
    if (owner) return;
    Promise.all([
      api("/notifications"),
      api("/complaints/me"),
      api("/announcements"),
    ]).then(([notifications, complaints, announcements]) => {
      setAccountDashboard({
        unreadNotifications: (notifications.notifications || []).filter((item) => !item.is_read).length,
        complaints: complaints.complaints || [],
        announcements: announcements.announcements || [],
      });
    }).catch(() => {});
  }, [owner]);

  useEffect(() => {
    if (role !== "BROKER") return;
    const loadBrokerFinance = () => api("/finance/me").then((result) => setBrokerFinance(result)).catch(() => {});
    loadBrokerFinance();
    const intervalId = window.setInterval(loadBrokerFinance, 30000);
    window.addEventListener("focus", loadBrokerFinance);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", loadBrokerFinance);
    };
  }, [role]);

  const cards = owner
    ? [
        [
          "إجمالي المستخدمين",
          ownerDashboard ? ownerDashboard.totalUsers.toLocaleString("ar-IQ") : "—",
          ownerDashboard ? `${ownerDashboard.activeUsers} نشط` : "جاري التحميل",
        ],
        [
          "الطلبات الجديدة",
          ownerDashboard ? ownerDashboard.pendingRequests : "—",
          "تحتاج مراجعة",
        ],
        [
          "الشكاوى المفتوحة",
          ownerDashboard ? ownerDashboard.openComplaints : "—",
          "تحتاج مراجعة",
        ],
        [
          "مستحقات الوسطاء",
          ownerDashboard ? ownerDashboard.brokerRemaining.toLocaleString("ar-IQ") : "—",
          "د.ع متبقية",
        ],
      ]
    : role === "BROKER"
    ? [
        [
          "إجمالي الرفعات",
          brokerFinance ? Number(brokerFinance.summary.total || 0).toLocaleString("ar-IQ") : "—",
          "د.ع",
        ],
        [
          "المدفوع",
          brokerFinance ? Number(brokerFinance.summary.paid || 0).toLocaleString("ar-IQ") : "—",
          "د.ع",
        ],
        [
          "المتبقي",
          brokerFinance ? Number(brokerFinance.summary.remaining || 0).toLocaleString("ar-IQ") : "—",
          "د.ع",
        ],
        [
          "عدد الدفعات",
          brokerFinance ? String((brokerFinance.payments || []).length) : "—",
          "سجل مالي فعلي",
        ],
      ]
    : [
        [
          "حالة الحساب",
          user.is_verified
            ? "مقبول"
            : "عضو",
          user.is_verified
            ? "تم التحقق"
            : "لا يوجد طلب نشط",
        ],
        [
          "الإشعارات",
          accountDashboard ? String(accountDashboard.unreadNotifications) : "—",
          "غير مقروءة",
        ],
        [
          "الشكاوى",
          accountDashboard ? String(accountDashboard.complaints.length) : "—",
          "تم إرسالها",
        ],
        [
          "التوجيهات",
          accountDashboard ? String(accountDashboard.announcements.length) : "—",
          "إعلانات متاحة",
        ],
      ];

  const quick = owner
    ? [
        [
          "الطلبات",
          "راجع الطلبات",
          "requests",
        ],
        [
          "الشكاوى",
          "إدارة الشكاوى",
          "complaints",
        ],
        ["المستخدمون", "إدارة الحسابات", "users"],
        ["المالية", "إدارة الوسطاء والدفعات", "finance"],
        ["الإعلانات", "نشر التوجيهات", "rules"],
      ]
    : role === "MEMBER"
    ? [
        [
          "طلب ادمن أو وسيط",
          "قدّم طلب ترقية حسابك",
          "application",
        ],
        [
          "تقديم شكوى",
          "اختر ادمن أو وسيط",
          "complaints",
        ],
      ]
    : role === "ADMIN"
    ? [
        [
          "حالة الطلب",
          "تابع طلبك",
          "application",
        ],
        [
          "الشكاوى",
          "تقديم ومتابعة شكواك",
          "complaints",
        ],
        [
          "الإشعارات",
          "آخر تحديثات حسابك",
          "notifications",
        ],
      ]
    : role === "BROKER"
    ? [
        ["المالية", "رصيدك ودفعاتك الفعلية", "finance"],
        ["الدفعات", "سجل الدفعات", "payments"],
        ["الإيصالات", "سجل إيصالاتك", "receipts"],
        ["الشكاوى", "تقديم ومتابعة شكوى", "complaints"],
      ]
    : [];

  return (
    <div className="page">
      <section className="hero">
        <small>
          DASHBOARD •{" "}
          {meta[role]?.[0] || role}
        </small>

        <h2>
          {owner
            ? "مركز قيادة Super Amazon"
            : role === "BROKER"
            ? "لوحتك المالية والإدارية"
            : "كل ما تحتاجه في مكان واحد"}
        </h2>

        <p>
          {owner
            ? "راقب المنصة وراجع الطلبات وأدر المستخدمين من لوحة واحدة."
            : "واجهة مخصصة حسب نوع حسابك."}
        </p>
      </section>

      <div className="stats">
        {cards.map((card) => (
          <div
            className="stat"
            key={card[0]}
          >
            <small>{card[0]}</small>
            <strong>{card[1]}</strong>
            <span>{card[2]}</span>
          </div>
        ))}
      </div>

      <h3>الوصول السريع</h3>

      <div className="quick">
        {quick.map((item) => (
          <button
            key={item[2]}
            onClick={() => setPage(item[2])}
          >
            <b>{item[0]}</b>
            <small>{item[1]}</small>
            <i>←</i>
          </button>
        ))}
      </div>
    </div>
  );
}

function Application({ user }) {
  const [request, setRequest] =
    useState(null);

  const [loading, setLoading] =
    useState(true);

  const [sending, setSending] =
    useState(false);

  const [editing, setEditing] =
    useState(false);

  const [accountType, setAccountType] =
    useState(
      user.account_type === "BROKER"
        ? "BROKER"
        : "ADMIN"
    );

  const [fullName, setFullName] =
    useState(user.telegram_name || "");

  const [fatherPhone, setFatherPhone] =
    useState("");

  const [nationalId, setNationalId] =
    useState("");

  const [latitude, setLatitude] =
    useState("");

  const [longitude, setLongitude] =
    useState("");

  const [
    locationAccuracy,
    setLocationAccuracy,
  ] = useState("");

  const [idFront, setIdFront] =
    useState(null);

  const [idBack, setIdBack] =
    useState(null);

  const [facePhoto, setFacePhoto] =
    useState(null);

  const [
    identityVideo,
    setIdentityVideo,
  ] = useState(null);

  useEffect(() => {
    loadRequest();
  }, []);

  async function loadRequest() {
    try {
      const result = await api(
        "/requests/me"
      );

      setRequest(
        result.request || null
      );
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  }

  function getLocation() {
    if (!navigator.geolocation) {
      alert(
        "المتصفح لا يدعم تحديد الموقع"
      );
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLatitude(
          position.coords.latitude
        );

        setLongitude(
          position.coords.longitude
        );

        setLocationAccuracy(
          position.coords.accuracy
        );
      },
      (error) => {
        console.error(error);

        alert(
          "تعذر الحصول على الموقع. تأكد من السماح للموقع."
        );
      },
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0,
      }
    );
  }

  async function submitRequest() {
    if (!fullName.trim()) {
      alert("اكتب الاسم الكامل");
      return;
    }

    if (!fatherPhone.trim()) {
      alert("اكتب رقم الهاتف");
      return;
    }

    if (!nationalId.trim()) {
      alert("اكتب رقم الأب");
      return;
    }

    if (!latitude || !longitude) {
      alert("يجب تحديد الموقع");
      return;
    }

    if (
      !idFront ||
      !idBack ||
      !facePhoto ||
      !identityVideo
    ) {
      alert(
        "يجب رفع جميع الملفات المطلوبة"
      );
      return;
    }

    const maxVideoSize =
      100 * 1024 * 1024;

    if (
      identityVideo.size >
      maxVideoSize
    ) {
      alert(
        "حجم الفيديو يجب ألا يتجاوز 100 MB"
      );
      return;
    }

    const form = new FormData();

    form.append(
      "accountType",
      accountType
    );

    form.append(
      "fullName",
      fullName.trim()
    );

    form.append(
      "fatherPhone",
      fatherPhone.trim()
    );

    form.append(
      "nationalId",
      nationalId.trim()
    );

    form.append(
      "latitude",
      String(latitude)
    );

    form.append(
      "longitude",
      String(longitude)
    );

    form.append(
      "locationAccuracy",
      String(locationAccuracy || "")
    );

    form.append(
      "idFront",
      idFront
    );

    form.append(
      "idBack",
      idBack
    );

    form.append(
      "facePhoto",
      facePhoto
    );

    form.append(
      "identityVideo",
      identityVideo
    );

    setSending(true);

    try {
      const result = await api(
        request && editing
          ? `/requests/${request.id}/correct`
          : "/requests",
        {
          method: request && editing ? "PATCH" : "POST",
          body: form,
        }
      );

      setRequest(result.request);
      setEditing(false);

      alert(
        `تم إرسال الطلب بنجاح\nرقم الطلب: ${result.request.request_number}`
      );
    } catch (error) {
      alert(error.message);
    } finally {
      setSending(false);
    }
  }

  if (loading) {
    return (
      <div className="page">
        <section className="panel">
          <h3>
            جاري تحميل حالة الطلب...
          </h3>
        </section>
      </div>
    );
  }

  if (request && !editing) {
    let statusText =
      request.status;

    if (
      request.status === "PENDING"
    ) {
      statusText = "قيد المراجعة";
    }

    if (
      request.status ===
      "NEEDS_CORRECTION"
    ) {
      statusText =
        "يحتاج إلى تعديل";
    }

    if (
      request.status === "APPROVED"
    ) {
      statusText =
        "تمت الموافقة";
    }

    if (
      request.status ===
      "REJECTED_FINAL"
    ) {
      statusText = "رفض نهائي";
    }

    return (
      <div className="page">
        <Title
          t="حالة الطلب"
          d="يمكنك متابعة حالة طلبك من هنا."
          i="▣"
        />

        <section className="panel">
          <h3>
            رقم الطلب: #
            {request.request_number}
          </h3>

          <p>
            نوع الطلب:{" "}
            <b>
              {request.applicant_type}
            </b>
          </p>

          <p>
            الحالة:{" "}
            <b>{statusText}</b>
          </p>

          <p>
            تاريخ التقديم:{" "}
            {request.submitted_at
              ? new Date(
                  request.submitted_at
                ).toLocaleString(
                  "ar-IQ"
                )
              : "—"}
          </p>

          {request.review_note && (
            <div
              style={{
                marginTop: "15px",
                padding: "15px",
                borderRadius: "12px",
                background:
                  "#fff4e5",
              }}
            >
              <b>
                ملاحظة الإدارة:
              </b>

              <p>
                {request.review_note}
              </p>
            </div>
          )}

          {request.status ===
            "PENDING" && (
            <div
              style={{
                marginTop: "20px",
                padding: "15px",
                borderRadius: "12px",
                background:
                  "#eef3ff",
              }}
            >
              طلبك قيد المراجعة
              من الإدارة.
            </div>
          )}

          {request.status ===
            "NEEDS_CORRECTION" && (
            <div
              style={{
                marginTop: "20px",
                padding: "15px",
                borderRadius: "12px",
                background:
                  "#fff4e5",
              }}
            >
              يرجى تعديل البيانات
              أو الملفات المطلوبة
              حسب ملاحظة الإدارة.
              <br />
              <button
                className="primary"
                style={{ marginTop: "14px" }}
                onClick={() => setEditing(true)}
              >
                تعديل الطلب وإعادة إرساله
              </button>
            </div>
          )}

          {request.status ===
            "REJECTED_FINAL" && (
            <div
              style={{
                marginTop: "20px",
                padding: "15px",
                borderRadius: "12px",
                background:
                  "#ffecec",
              }}
            >
              تم رفض الطلب
              نهائيًا، وسيبقى
              الحساب كمستخدم عادي.
            </div>
          )}

          {request.status ===
            "APPROVED" && (
            <div
              style={{
                marginTop: "20px",
                padding: "15px",
                borderRadius: "12px",
                background:
                  "#eaf8f0",
              }}
            >
              تمت الموافقة على
              طلبك بنجاح.
            </div>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="page">
      <Title
        t="تقديم طلب"
        d="أكمل المعلومات وارفع الملفات المطلوبة."
        i="▣"
      />

      <section className="panel">
        {editing && (
          <div className="upload">
            أعد إدخال البيانات وارفع الملفات الأربعة من جديد، ثم أرسل التصحيحات.
          </div>
        )}
        <h3>
          نوع الحساب المطلوب
        </h3>

        <div className="seg">
          <button
            className={
              accountType === "ADMIN"
                ? "on"
                : ""
            }
            onClick={() =>
              setAccountType("ADMIN")
            }
          >
            ادمن
          </button>

          <button
            className={
              accountType === "BROKER"
                ? "on"
                : ""
            }
            onClick={() =>
              setAccountType("BROKER")
            }
          >
            وسيط
          </button>
        </div>

        <label>
          الاسم الكامل
        </label>

        <input
          value={fullName}
          onChange={(e) =>
            setFullName(e.target.value)
          }
          placeholder="الاسم الكامل"
        />

        <label>
          رقم الهاتف
        </label>

        <input
          value={fatherPhone}
          onChange={(e) =>
            setFatherPhone(
              e.target.value
            )
          }
          placeholder="رقم الهاتف"
        />

        <label>
          رقم الأب
        </label>

        <input
          value={nationalId}
          onChange={(e) =>
            setNationalId(
              e.target.value
            )
          }
          placeholder="رقم الأب"
        />

        <label>
          الموقع الجغرافي
        </label>

        <button
          className="secondary"
          onClick={getLocation}
        >
          📍 تحديد موقعي الحالي
        </button>

        {latitude &&
          longitude && (
            <div
              style={{
                marginTop: "10px",
                fontSize: "10px",
                lineHeight: "1.8",
              }}
            >
              ✓ تم تحديد الموقع
              <br />
              Latitude: {latitude}
              <br />
              Longitude: {longitude}
              <br />
              Accuracy:{" "}
              {locationAccuracy} متر
            </div>
          )}

        <label>
          صورة المستمسك الأمامي
        </label>

        <input
          type="file"
          accept="image/*"
          onChange={(e) =>
            setIdFront(
              e.target.files?.[0] ||
                null
            )
          }
        />

        <label>
          صورة المستمسك الخلفي
        </label>

        <input
          type="file"
          accept="image/*"
          onChange={(e) =>
            setIdBack(
              e.target.files?.[0] ||
                null
            )
          }
        />

        <label>
          الصورة الشخصية
        </label>

        <input
          type="file"
          accept="image/*"
          onChange={(e) =>
            setFacePhoto(
              e.target.files?.[0] ||
                null
            )
          }
        />

        <label>
          فيديو التحقق
        </label>

        <input
          type="file"
          accept="video/*"
          onChange={(e) =>
            setIdentityVideo(
              e.target.files?.[0] ||
                null
            )
          }
        />

        {identityVideo && (
          <small
            style={{
              display: "block",
              marginTop: "8px",
            }}
          >
            حجم الفيديو:{" "}
            {(
              identityVideo.size /
              1024 /
              1024
            ).toFixed(2)}{" "}
            MB
          </small>
        )}

        <div
          style={{
            marginTop: "20px",
          }}
        >
          <button
            className="primary"
            disabled={sending}
            onClick={submitRequest}
          >
            {sending
              ? "جاري إرسال الطلب..."
              : "إرسال الطلب"}
          </button>
        </div>
      </section>
    </div>
  );
}

function Complaints({ role }) {
  if (role === "OWNER" || role === "OWNER_ASSISTANT") {
    return <OwnerComplaints />;
  }
  return <MemberComplaints />;
}

function MemberComplaints() {
  const [targets, setTargets] =
    useState([]);

  const [targetType, setTargetType] =
    useState("BROKER");

  const [target, setTarget] =
    useState("");

  const [body, setBody] =
    useState("");

  const [attachments, setAttachments] =
    useState([]);

  const [items, setItems] =
    useState([]);

  const [loading, setLoading] =
    useState(true);

  const [sending, setSending] =
    useState(false);

  useEffect(() => {
    loadComplaints();
    const intervalId = window.setInterval(loadComplaints, 30000);
    window.addEventListener("focus", loadComplaints);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", loadComplaints);
    };
  }, []);

  async function loadComplaints() {
    try {
      const [
        targetsResult,
        complaintsResult,
      ] = await Promise.all([
        api("/complaints/targets"),
        api("/complaints/me"),
      ]);

      setTargets(
        targetsResult.targets || []
      );

      setItems(
        complaintsResult.complaints ||
          []
      );
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  }

  const filteredTargets =
    targets.filter(
      (item) =>
        item.account_type ===
        targetType
    );

  async function sendComplaint() {
    if (!target) {
      alert("اختر الشخص أولًا");
      return;
    }

    if (body.trim().length < 5) {
      alert(
        "اكتب تفاصيل الشكوى"
      );
      return;
    }

    setSending(true);

    try {
      const form = new FormData();
      form.append("targetUserId", target);
      form.append("targetType", targetType);
      form.append("body", body.trim());
      attachments.forEach((file) => form.append("attachments", file));

      await api("/complaints", {
        method: "POST",
        body: form,
      });

      setBody("");
      setTarget("");
      setAttachments([]);

      await loadComplaints();

      alert(
        "تم إرسال الشكوى بنجاح"
      );
    } catch (error) {
      alert(error.message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="page">
      <Title
        t="الشكاوى"
        d="قدم شكوى بطريقة واضحة وتابع حالتها."
        i="⚑"
      />

      <div className="cols">
        <section className="panel">
          <h3>
            تقديم شكوى جديدة
          </h3>

          <label>القسم</label>

          <div className="seg">
            {["ADMIN", "BROKER"].map(
              (type) => (
                <button
                  key={type}
                  className={
                    targetType ===
                    type
                      ? "on"
                      : ""
                  }
                  onClick={() => {
                    setTargetType(
                      type
                    );
                    setTarget("");
                  }}
                >
                  {accountLabel(type)}
                </button>
              )
            )}
          </div>

          <label>
            اختر الشخص
          </label>

          <select
            value={target}
            onChange={(e) =>
              setTarget(
                e.target.value
              )
            }
          >
            <option value="">
              اختر الشخص
            </option>

            {filteredTargets.map(
              (item) => (
                <option
                  key={item.id}
                  value={item.id}
                >
                  {item.telegram_name ||
                    "بدون اسم"}{" "}
                  {item.telegram_username
                    ? `(@${item.telegram_username})`
                    : ""}
                </option>
              )
            )}
          </select>

          <label>
            تفاصيل الشكوى
          </label>

          <textarea
            rows="7"
            value={body}
            onChange={(e) =>
              setBody(e.target.value)
            }
            placeholder="اكتب تفاصيل الشكوى هنا..."
          />

          <div className="upload">
            <b>إرفاق أدلة الشكوى</b>
            <small>صور أو فيديوهات، حتى 4 ملفات وبحد أقصى 100MB للملف.</small>
            <input
              type="file"
              accept="image/*,video/mp4,video/webm,video/quicktime"
              multiple
              onChange={(event) => setAttachments(Array.from(event.target.files || []).slice(0, 4))}
            />
            {attachments.length > 0 && <small>تم اختيار {attachments.length} ملف/ملفات.</small>}
          </div>

          <button
            className="primary"
            disabled={sending}
            onClick={sendComplaint}
          >
            {sending
              ? "جاري الإرسال..."
              : "إرسال الشكوى"}
          </button>
        </section>

        <section className="panel">
          <h3>
            شكاواي السابقة
          </h3>

          {loading ? (
            <p>
              جاري التحميل...
            </p>
          ) : items.length === 0 ? (
            <p>
              لا توجد شكاوى.
            </p>
          ) : (
            items.map((item) => (
              <div
                className="complaint-row"
                key={item.id}
              >
                <b>
                  {item.target_type}
                </b>

                <span>
                  {item.target_name ||
                    "—"}{" "}
                  {item.target_username
                    ? `@${item.target_username}`
                    : ""}
                </span>

                <small>
                  {item.status} •{" "}
                  {new Date(
                    item.created_at
                  ).toLocaleString(
                    "ar-IQ"
                  )}
                </small>

                <p>
                  {item.body}
                </p>
              </div>
            ))
          )}
        </section>
      </div>
    </div>
  );
}

function Notifications() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [testMessage, setTestMessage] = useState("");

  async function loadNotifications() {
    try {
      const result = await api("/notifications");
      setItems(result.notifications || []);
    } catch (error) {
      alert(error.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadNotifications(); }, []);

  async function markRead(id) {
    try {
      await api(`/notifications/${id}/read`, { method: "PATCH" });
      setItems((current) => current.map((item) => item.id === id ? { ...item, is_read: true } : item));
    } catch (error) { alert(error.message); }
  }

  async function markAllRead() {
    try {
      await api("/notifications/read-all", { method: "PATCH" });
      setItems((current) => current.map((item) => ({ ...item, is_read: true })));
    } catch (error) { alert(error.message); }
  }

  async function testTelegram() {
    setTestMessage("جاري الإرسال...");
    try { const result = await api("/notifications/test-telegram", { method: "POST" }); setTestMessage(result.message); }
    catch (error) { setTestMessage(error.message); }
  }

  return (
    <div className="page">
      <Title t="الإشعارات" d="تابع آخر تحديثات حسابك وطلباتك." i="◉" />
      <section className="notification-toolbar">
        <div><b>{items.filter((item) => !item.is_read).length}</b><span>إشعارات غير مقروءة</span></div>
        <div><button className="secondary" onClick={testTelegram}>اختبار Telegram</button> <button className="secondary" onClick={markAllRead}>تحديد الكل كمقروء</button></div>
      </section>
      {testMessage && <p className="settings-saved">{testMessage}</p>}
      <section className="notification-list">
        {loading ? <p>جاري التحميل...</p> : items.length === 0 ? <div className="empty-state"><b>◉</b><h3>لا توجد إشعارات</h3><p>ستظهر هنا تحديثات طلباتك وإعلانات المنصة.</p></div> : items.map((item) => (
          <button className={`notification-card ${item.is_read ? "" : "unread"}`} key={item.id} onClick={() => !item.is_read && markRead(item.id)}>
            <i>{item.is_read ? "✓" : "●"}</i><div><b>{item.title}</b><span>{item.body}</span><small>{new Date(item.created_at).toLocaleString("ar-IQ")}</small></div>
          </button>
        ))}
      </section>
    </div>
  );
}

function OwnerComplaints() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState("");
  const [selected, setSelected] = useState(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [message, setMessage] = useState("");

  async function loadComplaints() {
    try {
      const result = await api("/owner/complaints");
      setItems(result.complaints || []);
    } catch (error) { setMessage(error.message); } finally { setLoading(false); }
  }
  useEffect(() => {
    loadComplaints();
    const intervalId = window.setInterval(loadComplaints, 30000);
    window.addEventListener("focus", loadComplaints);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", loadComplaints);
    };
  }, []);

  useEffect(() => {
    if (!selectedId) return setSelected(null);
    setDetailsLoading(true);
    setMessage("");
    api(`/owner/complaints/${selectedId}`)
      .then((result) => setSelected(result.complaint))
      .catch((error) => setMessage(error.message))
      .finally(() => setDetailsLoading(false));
  }, [selectedId]);

  async function review(item, status) {
    const note = prompt("ملاحظة الإدارة للمستخدم (اختياري):", item.owner_note || "");
    if (note === null) return;
    try {
      await api(`/owner/complaints/${item.id}`, { method: "PATCH", body: JSON.stringify({ status, note }) });
      await loadComplaints();
      const result = await api(`/owner/complaints/${item.id}`);
      setSelected(result.complaint);
      setMessage("تم تحديث حالة الشكوى.");
    } catch (error) { setMessage(error.message); }
  }

  return (
    <div className="page">
      <Title t="إدارة الشكاوى" d="افتح كل شكوى لمراجعة بياناتها وأدلتها بشكل مستقل." i="⚑" />
      {message && <p className="settings-saved">{message}</p>}
      {!selectedId ? <section className="panel">
        {loading ? <p>جاري التحميل...</p> : items.length === 0 ? <p>لا توجد شكاوى.</p> : <div className="table"><div className="tr head"><span>الشكوى</span><span>مقدم الشكوى</span><span>ضد</span><span>المراجعة</span></div>{items.map((item) => <div className="tr" key={item.id}><span>#{item.id.slice(0, 8)}<br /><small>{new Date(item.created_at).toLocaleString("ar-IQ")}</small></span><span>{item.complainant_name || "—"}<br /><small>{item.complainant_username ? `@${item.complainant_username}` : "بدون معرف"}</small></span><span>{item.target_name || "—"}<br /><small>{accountLabel(item.target_type)}</small></span><span>{item.status}<br /><button className="secondary" onClick={() => setSelectedId(item.id)}>فتح الشكوى</button></span></div>)}</div>}
      </section> : <ComplaintReview complaint={selected} loading={detailsLoading} onBack={() => setSelectedId("")} onReview={review} />}
    </div>
  );
}

function ComplaintReview({ complaint, loading, onBack, onReview }) {
  const [previews, setPreviews] = useState({});
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    const urls = [];
    async function loadPreviews() {
      if (!complaint?.files?.length) return;
      try {
        const token = localStorage.getItem("sa_token");
        const output = await Promise.all(complaint.files.map(async (file) => {
          const response = await fetch(`${API}/owner/complaints/${complaint.id}/files/${file.id}`, { headers: { Authorization: `Bearer ${token}` } });
          if (!response.ok) throw new Error("تعذر تحميل أحد مرفقات الشكوى");
          const url = URL.createObjectURL(await response.blob());
          urls.push(url);
          return [file.id, url];
        }));
        if (alive) setPreviews(Object.fromEntries(output));
      } catch (loadError) { if (alive) setError(loadError.message); }
    }
    loadPreviews();
    return () => { alive = false; urls.forEach((url) => URL.revokeObjectURL(url)); };
  }, [complaint?.id]);

  if (loading || !complaint) return <section className="panel"><p>جاري تحميل تفاصيل الشكوى...</p></section>;
  const status = { NEW: "جديدة", UNDER_REVIEW: "قيد المراجعة", RESOLVED: "تم الحل", REJECTED: "مرفوضة" }[complaint.status] || complaint.status;
  return <>
    <button className="secondary" onClick={onBack}>← العودة إلى جميع الشكاوى</button>
    <section className="panel" style={{ marginTop: "15px" }}><h3>شكوى #{complaint.id.slice(0, 8)} • {status}</h3><Table rows={[
      ["مقدم الشكوى", complaint.complainant_name || "—", "نوع حسابه", accountLabel(complaint.complainant_account_type)],
      ["حساب Telegram", complaint.complainant_username ? `@${complaint.complainant_username}` : "—", "Telegram ID", complaint.complainant_telegram_id || "—"],
      ["المشكو عليه", complaint.target_name || "—", "نوع الحساب", accountLabel(complaint.target_type)],
      ["حساب Telegram", complaint.target_username ? `@${complaint.target_username}` : "—", "Telegram ID", complaint.target_telegram_id || "—"],
      ["تاريخ الإرسال", new Date(complaint.created_at).toLocaleString("ar-IQ"), "آخر تحديث", new Date(complaint.updated_at).toLocaleString("ar-IQ")],
    ]} /><div style={{ marginTop: "18px" }}><h3>تفاصيل الشكوى</h3><p style={{ whiteSpace: "pre-wrap" }}>{complaint.body}</p></div>{complaint.owner_note && <div className="notice" style={{ marginTop: "15px" }}><b>ملاحظة المراجعة السابقة</b><p>{complaint.owner_note}</p></div>}</section>
    <section className="panel" style={{ marginTop: "18px" }}><h3>المرفقات والأدلة</h3>{error && <p className="error">{error}</p>}{complaint.files.length === 0 ? <p>لم يتم إرفاق ملفات مع هذه الشكوى.</p> : <div className="attachment-grid">{complaint.files.map((file) => <article className="attachment" key={file.id}><b>{file.mime_type.startsWith("video/") ? "فيديو دليل" : "صورة دليل"}</b><small>{file.original_name} • {(Number(file.file_size) / 1024 / 1024).toFixed(2)} MB</small>{previews[file.id] && file.mime_type.startsWith("image/") && <img src={previews[file.id]} alt={file.original_name} />}{previews[file.id] && file.mime_type.startsWith("video/") && <video controls src={previews[file.id]} />}{previews[file.id] && <a className="secondary" href={previews[file.id]} target="_blank" rel="noreferrer">فتح المرفق</a>}</article>)}</div>}</section>
    <section className="panel" style={{ marginTop: "18px" }}><h3>قرار المراجعة</h3><div className="inline-actions"><button className="secondary" onClick={() => onReview(complaint, "UNDER_REVIEW")}>قيد المراجعة</button><button className="primary" onClick={() => onReview(complaint, "RESOLVED")}>حل الشكوى</button><button className="secondary" onClick={() => onReview(complaint, "REJECTED")}>رفض الشكوى</button></div></section>
  </>;
}

function Requests() {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState("");
  const [selected, setSelected] = useState(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [message, setMessage] = useState("");
  async function loadRequests() {
    try { const result = await api("/owner/requests"); setData(result.requests || []); }
    catch (error) { setMessage(error.message); } finally { setLoading(false); }
  }
  useEffect(() => { loadRequests(); }, []);
  useEffect(() => {
    if (!selectedId) return setSelected(null);
    setDetailsLoading(true); setMessage("");
    api(`/owner/requests/${selectedId}`).then((result) => setSelected(result.request)).catch((error) => setMessage(error.message)).finally(() => setDetailsLoading(false));
  }, [selectedId]);
  async function review(id, decision) {
    const note = prompt(decision === "NEEDS_CORRECTION" ? "حدد النقص أو الخطأ:" : "ملاحظة المراجعة (اختيارية):", "");
    if (note === null) return;
    try { await api(`/owner/requests/${id}/review`, { method: "PATCH", body: JSON.stringify({ decision, note }) }); setMessage("تم تحديث قرار مراجعة الطلب."); await loadRequests(); const result = await api(`/owner/requests/${id}`); setSelected(result.request); }
    catch (error) { setMessage(error.message); }
  }
  return <div className="page"><Title t="طلبات التقديم" d="افتح كل طلب لمراجعة بياناته ومرفقاته بشكل مستقل." i="✓" />
    {message && <p className="settings-saved">{message}</p>}
    {!selectedId ? <section className="panel">{loading ? <p>جاري التحميل...</p> : data.length === 0 ? <p>لا توجد طلبات حاليًا.</p> : <div className="table"><div className="tr head"><span>الطلب</span><span>المتقدم</span><span>النوع</span><span>المراجعة</span></div>{data.map((item) => <div className="tr" key={item.id}><span>#{item.request_number}</span><span>{item.full_name}<br /><small>@{item.telegram_username || "—"}</small></span><span>{accountLabel(item.applicant_type)}</span><span>{item.status}<br /><button className="secondary" onClick={() => setSelectedId(item.id)}>فتح الطلب</button></span></div>)}</div>}</section> : <RequestReview request={selected} loading={detailsLoading} onBack={() => setSelectedId("")} onReview={review} />}
  </div>;
}

function RequestReview({ request, loading, onBack, onReview }) {
  const [previews, setPreviews] = useState({});
  const [message, setMessage] = useState("");
  useEffect(() => {
    let alive = true; const urls = [];
    async function loadPreviews() {
      if (!request?.files?.length) return;
      try {
        const token = localStorage.getItem("sa_token");
        const output = await Promise.all(request.files.map(async (file) => {
          const response = await fetch(`${API}/owner/requests/${request.id}/files/${file.id}`, { headers: { Authorization: `Bearer ${token}` } });
          if (!response.ok) throw new Error("تعذر تحميل أحد المرفقات");
          const url = URL.createObjectURL(await response.blob()); urls.push(url); return [file.id, url];
        }));
        if (alive) setPreviews(Object.fromEntries(output));
      } catch (error) { if (alive) setMessage(error.message); }
    }
    loadPreviews(); return () => { alive = false; urls.forEach((url) => URL.revokeObjectURL(url)); };
  }, [request?.id]);
  const labels = { ID_FRONT: "المستمسك الأمامي", ID_BACK: "المستمسك الخلفي", FACE_PHOTO: "الصورة الشخصية", IDENTITY_VIDEO: "فيديو التحقق" };
  if (loading || !request) return <section className="panel"><p>جاري تحميل الطلب...</p></section>;
  return <><button className="secondary" onClick={onBack}>← العودة إلى جميع الطلبات</button><section className="panel" style={{ marginTop: "15px" }}><h3>طلب #{request.request_number} • {accountLabel(request.applicant_type)}</h3><Table rows={[["الاسم الكامل", request.full_name, "حالة الطلب", request.status],["رقم الهاتف", request.father_phone, "رقم الأب", request.national_id],["حساب Telegram", `@${request.telegram_username || "—"}`, "Telegram ID", request.telegram_id],["الموقع", `${Number(request.latitude).toFixed(5)}, ${Number(request.longitude).toFixed(5)}`, "دقة الموقع", request.location_accuracy ? `${request.location_accuracy} متر` : "—"],["تاريخ الإرسال", new Date(request.submitted_at).toLocaleString("ar-IQ"), "الحساب الحالي", accountLabel(request.account_type)]]} /></section><section className="panel" style={{ marginTop: "18px" }}><h3>المرفقات والتحقق</h3>{message && <p className="error">{message}</p>}<div className="attachment-grid">{request.files.map((file) => <article className="attachment" key={file.id}><b>{labels[file.file_type] || file.file_type}</b><small>{file.original_name} • {(Number(file.file_size) / 1024 / 1024).toFixed(2)} MB</small>{previews[file.id] && file.mime_type.startsWith("image/") && <img src={previews[file.id]} alt={labels[file.file_type]} />}{previews[file.id] && file.mime_type.startsWith("video/") && <video controls src={previews[file.id]} />}{previews[file.id] && <a className="secondary" href={previews[file.id]} target="_blank" rel="noreferrer">فتح المرفق</a>}</article>)}</div></section><section className="panel" style={{ marginTop: "18px" }}><h3>قرار المراجعة</h3>{request.status === "PENDING" ? <div className="inline-actions"><button className="primary" onClick={() => onReview(request.id, "APPROVED")}>موافقة وترقية الحساب</button><button className="secondary" onClick={() => onReview(request.id, "NEEDS_CORRECTION")}>طلب تصحيح</button><button className="secondary" onClick={() => onReview(request.id, "REJECTED_FINAL")}>رفض نهائي</button></div> : <p>هذا الطلب تمت مراجعته سابقًا: <b>{request.status}</b>{request.review_note ? ` — ${request.review_note}` : ""}</p>}</section></>;
}

function Users() {
  const [data, setData] =
    useState([]);

  const [loading, setLoading] =
    useState(true);

  useEffect(() => {
    api("/owner/users")
      .then((result) =>
        setData(result.users || [])
      )
      .catch((error) =>
        alert(error.message)
      )
      .finally(() =>
        setLoading(false)
      );
  }, []);

  return (
    <div className="page">
      <Title
        t="المستخدمون"
        d="بيانات الحسابات المتاحة لـ Owner."
        i="♟"
      />

      <section className="panel">
        {loading ? (
          <p>جاري التحميل...</p>
        ) : (
          <div className="table">
            <div className="tr head">
              <span>الاسم</span>
              <span>Telegram</span>
              <span>النوع</span>
              <span>الحالة</span>
            </div>

            {data.map((user) => (
              <div
                className="tr"
                key={user.id}
              >
                <span>
                  <bdi className="unicode-text">{user.telegram_name || "—"}</bdi>
                </span>

                <span>
                  @
                  {user.telegram_username ||
                    "—"}
                </span>

                <span>
                  {user.account_type}
                </span>

                <span>
                  {user.status}{" "}
                  {user.is_verified
                    ? "✓"
                    : ""}
                  <br />
                  <button
                    onClick={async () => {
                      const nextStatus = user.status === "SUSPENDED" ? "ACTIVE" : "SUSPENDED";
                      if (!confirm(nextStatus === "SUSPENDED" ? "إيقاف هذا الحساب؟" : "تفعيل هذا الحساب؟")) return;
                      try {
                        await api(`/owner/users/${user.id}/status`, { method: "PATCH", body: JSON.stringify({ status: nextStatus }) });
                        setData((items) => items.map((item) => item.id === user.id ? { ...item, status: nextStatus } : item));
                      } catch (error) { alert(error.message); }
                    }}
                  >
                    {user.status === "SUSPENDED" ? "تفعيل" : "إيقاف"}
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Announcements({ role }) {
  const owner = role === "OWNER" || role === "OWNER_ASSISTANT";
  const [items, setItems] = useState([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [important, setImportant] = useState(false);
  const [sending, setSending] = useState(false);

  async function loadAnnouncements() {
    try {
      const result = await api(owner ? "/announcements/manage" : "/announcements");
      setItems(result.announcements || []);
    } catch (error) { alert(error.message); }
  }
  useEffect(() => { loadAnnouncements(); }, []);

  async function createAnnouncement() {
    if (!title.trim() || !body.trim()) return alert("اكتب العنوان والمحتوى");
    setSending(true);
    try {
      await api("/announcements/manage", { method: "POST", body: JSON.stringify({ title: title.trim(), body: body.trim(), important, published: true }) });
      setTitle(""); setBody(""); setImportant(false); await loadAnnouncements();
    } catch (error) { alert(error.message); } finally { setSending(false); }
  }

  return (
    <div className="page">
      <Title t={owner ? "الإعلانات والتوجيهات" : "القوانين والتوجيهات"} d="آخر تحديثات وتعليمات المنصة." i="▤" />
      {owner && <section className="panel" style={{ marginBottom: "18px" }}>
        <h3>إعلان جديد</h3>
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="عنوان الإعلان" />
        <textarea rows="5" value={body} onChange={(event) => setBody(event.target.value)} placeholder="محتوى الإعلان" />
        <label><input type="checkbox" checked={important} onChange={(event) => setImportant(event.target.checked)} /> إعلان مهم</label>
        <button className="primary" disabled={sending} onClick={createAnnouncement}>{sending ? "جاري النشر..." : "نشر الإعلان"}</button>
      </section>}
      <section className="panel">
        {items.length === 0 ? <p>لا توجد إعلانات حاليًا.</p> : items.map((item) => (
          <article className="complaint-row" key={item.id}>
            <b>{item.important ? "مهم • " : ""}{item.title}</b>
            <p>{item.body}</p>
            <small>{new Date(item.created_at).toLocaleString("ar-IQ")}{owner ? ` • ${item.published ? "منشور" : "مسودة"}` : ""}</small>
          </article>
        ))}
      </section>
    </div>
  );
}

function Finance({ role }) {
  if (role === "OWNER" || role === "OWNER_ASSISTANT") return <OwnerFinance />;
  const [data, setData] = useState({ summary: { total: 0, paid: 0, remaining: 0 }, payments: [] });
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const loadFinance = () => api("/finance/me")
      .then((result) => setData({ summary: result.summary, payments: result.payments || [] }))
      .catch((error) => console.error(error))
      .finally(() => setLoading(false));
    loadFinance();
    const intervalId = window.setInterval(loadFinance, 30000);
    window.addEventListener("focus", loadFinance);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", loadFinance);
    };
  }, []);
  const money = (value) => Number(value || 0).toLocaleString("ar-IQ");
  return <div className="page">
    <Title t="المالية" d="عرض وضعك المالي بشكل واضح." i="₿" />
    <section className="finance"><small>المتبقي</small><strong>{money(data.summary.remaining)} د.ع</strong><span>من إجمالي {money(data.summary.total)} د.ع</span><div><i /></div></section>
    <div className="stats">
      <div className="stat"><small>إجمالي الرفعات</small><strong>{money(data.summary.total)}</strong><span>د.ع</span></div>
      <div className="stat"><small>المدفوع</small><strong>{money(data.summary.paid)}</strong><span>د.ع</span></div>
      <div className="stat"><small>المتبقي</small><strong>{money(data.summary.remaining)}</strong><span>د.ع</span></div>
    </div>
    <section className="panel"><h3>آخر الدفعات</h3>{loading ? <p>جاري التحميل...</p> : <Table rows={data.payments.length ? data.payments.map((payment) => [payment.payment_type, money(payment.amount) + " د.ع", new Date(payment.payment_date).toLocaleDateString("ar-IQ"), payment.note || "—"]) : [["لا توجد دفعات", "—", "—", "—"]]} />}</section>
  </div>;
}

function BrokerLedger({ mode }) {
  const [data, setData] = useState({ summary: { total: 0, paid: 0, remaining: 0 }, payments: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const loadLedger = () => api("/finance/me")
      .then((result) => {
        setData({ summary: result.summary || { total: 0, paid: 0, remaining: 0 }, payments: result.payments || [] });
        setError("");
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
    loadLedger();
    const intervalId = window.setInterval(loadLedger, 30000);
    window.addEventListener("focus", loadLedger);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", loadLedger);
    };
  }, []);

  const money = (value) => Number(value || 0).toLocaleString("ar-IQ");
  const title = mode === "receipts" ? "الإيصالات المالية" : "سجل الدفعات";
  const description = mode === "receipts"
    ? "إيصالات دفعاتك المسجلة من الإدارة."
    : "جميع الدفعات المرتبطة بحسابك، مباشرة من السجل المالي.";

  return <div className="page">
    <Title t={title} d={description} i={mode === "receipts" ? "▧" : "↗"} />
    {error && <p className="error">{error}</p>}
    <div className="stats">
      <div className="stat"><small>إجمالي الرفعات</small><strong>{money(data.summary.total)}</strong><span>د.ع</span></div>
      <div className="stat"><small>إجمالي المدفوع</small><strong>{money(data.summary.paid)}</strong><span>د.ع</span></div>
      <div className="stat"><small>المتبقي</small><strong>{money(data.summary.remaining)}</strong><span>د.ع</span></div>
    </div>
    <section className="panel">
      <h3>{mode === "receipts" ? "الإيصالات المتاحة" : "الدفعات المسجلة"}</h3>
      {loading ? <p>جاري تحميل السجل المالي...</p> : <Table rows={data.payments.length ? data.payments.map((payment) => [
        mode === "receipts" ? "إيصال دفعة" : payment.payment_type,
        `${money(payment.amount)} د.ع`,
        new Date(payment.payment_date).toLocaleString("ar-IQ"),
        payment.note || "دفعة مسجلة من الإدارة",
      ]) : [["لا يوجد سجل مالي بعد", "—", "—", "—"]]} />}
    </section>
  </div>;
}

function OwnerFinance() {
  const [brokers, setBrokers] = useState([]);
  const [brokerId, setBrokerId] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("CASH");
  const [paymentBrokerId, setPaymentBrokerId] = useState("");
  const [lifts, setLifts] = useState([]);
  const [liftId, setLiftId] = useState("");
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentNote, setPaymentNote] = useState("");
  const [message, setMessage] = useState("");
  async function load() {
    try { const result = await api("/owner/finance/brokers"); setBrokers(result.brokers || []); } catch (error) { setMessage(error.message); }
  }
  useEffect(() => {
    load();
    const intervalId = window.setInterval(load, 30000);
    window.addEventListener("focus", load);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", load);
    };
  }, []);
  async function addLift() {
    if (!brokerId || !Number(amount)) return setMessage("اختر وسيطًا واكتب المبلغ.");
    try { await api("/owner/finance/lifts", { method: "POST", body: JSON.stringify({ brokerId, amount: Number(amount), paymentMethod: method }) }); setAmount(""); setMessage("تمت إضافة الرفعة المالية."); load(); } catch (error) { setMessage(error.message); }
  }
  async function loadLifts(id) {
    setPaymentBrokerId(id); setLiftId(""); setLifts([]);
    if (!id) return;
    try { const result = await api(`/owner/finance/brokers/${id}/lifts`); setLifts(result.lifts || []); } catch (error) { setMessage(error.message); }
  }
  async function addPayment() {
    if (!paymentBrokerId || !liftId || !Number(paymentAmount)) return setMessage("اختر الوسيط والرفعة واكتب مبلغ الدفعة.");
    try {
      await api("/owner/finance/payments", { method: "POST", body: JSON.stringify({ brokerId: paymentBrokerId, liftId, amount: Number(paymentAmount), note: paymentNote }) });
      setPaymentAmount(""); setPaymentNote(""); setMessage("تم تسجيل الدفعة وتحديث رصيد الوسيط."); load(); loadLifts(paymentBrokerId);
    } catch (error) { setMessage(error.message); }
  }
  return <div className="page">
    <Title t="مالية الوسطاء" d="أضف الرفعات وتابع الأرصدة المتبقية." i="₿" />
    <section className="panel"><h3>إضافة رفعة مالية</h3><select value={brokerId} onChange={(event) => setBrokerId(event.target.value)}><option value="">اختر الوسيط</option>{brokers.map((broker) => <option key={broker.id} value={broker.id}>{broker.telegram_name || broker.telegram_username || "وسيط"}</option>)}</select><input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="numeric" placeholder="المبلغ بالدينار العراقي" /><div className="seg"><button className={method === "CASH" ? "on" : ""} onClick={() => setMethod("CASH")}>نقدي</button><button className={method === "INSTALLMENTS" ? "on" : ""} onClick={() => setMethod("INSTALLMENTS")}>أقساط</button></div><button className="primary" onClick={addLift}>إضافة الرفعة</button></section>
    <section className="panel" style={{ marginTop: "18px" }}><h3>تسجيل دفعة لوسيط</h3><select value={paymentBrokerId} onChange={(event) => loadLifts(event.target.value)}><option value="">اختر الوسيط</option>{brokers.map((broker) => <option key={broker.id} value={broker.id}>{broker.telegram_name || broker.telegram_username || "وسيط"}</option>)}</select><select value={liftId} disabled={!paymentBrokerId} onChange={(event) => setLiftId(event.target.value)}><option value="">اختر الرفعة</option>{lifts.filter((lift) => Number(lift.total_amount) > Number(lift.paid_amount)).map((lift) => <option key={lift.id} value={lift.id}>متبقي {Number(lift.total_amount - lift.paid_amount).toLocaleString("ar-IQ")} د.ع</option>)}</select><input value={paymentAmount} onChange={(event) => setPaymentAmount(event.target.value)} inputMode="numeric" placeholder="قيمة الدفعة بالدينار العراقي" /><textarea rows="3" value={paymentNote} onChange={(event) => setPaymentNote(event.target.value)} placeholder="ملاحظة اختيارية" /><button className="secondary" onClick={addPayment}>تسجيل الدفعة</button>{message && <p className="settings-saved">{message}</p>}</section>
    <section className="panel" style={{ marginTop: "18px" }}><h3>أرصدة الوسطاء</h3><Table rows={brokers.length ? brokers.map((broker) => [broker.telegram_name || "—", Number(broker.total).toLocaleString("ar-IQ"), Number(broker.paid).toLocaleString("ar-IQ"), (Number(broker.total) - Number(broker.paid)).toLocaleString("ar-IQ")]) : [["لا يوجد وسطاء", "—", "—", "—"]]} /></section>
  </div>;
}

function OwnerReports() {
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => { api("/owner/reports").then((result) => setReport(result.report)).catch((err) => setError(err.message)); }, []);
  const count = (rows, name) => Number((rows || []).find((item) => item.status === name || item.account_type === name)?.total || 0);
  const money = (value) => Number(value || 0).toLocaleString("ar-IQ");
  return <div className="page"><Title t="تقارير المنصة" d="ملخص حيّ للحسابات والطلبات والشكاوى والمالية." i="▥" />
    {error && <p className="error">{error}</p>}
    {!report ? <section className="panel"><p>جاري إعداد التقرير...</p></section> : <>
      <div className="stats"><div className="stat"><small>الأعضاء</small><strong>{count(report.users, "MEMBER")}</strong><span>حساب</span></div><div className="stat"><small>ادمن</small><strong>{count(report.users, "ADMIN")}</strong><span>حساب</span></div><div className="stat"><small>الوسطاء</small><strong>{count(report.users, "BROKER")}</strong><span>حساب</span></div></div>
      <section className="panel"><h3>الطلبات والشكاوى</h3><Table rows={[["طلبات بانتظار المراجعة", count(report.requests, "PENDING"), "طلبات", "مفتوحة"],["طلبات معتمدة", count(report.requests, "APPROVED"), "طلبات", "مكتملة"],["شكاوى جديدة", count(report.complaints, "NEW"), "شكاوى", "تحتاج مراجعة"],["شكاوى محلولة", count(report.complaints, "RESOLVED"), "شكاوى", "مغلقة"]]} /></section>
      <section className="panel" style={{ marginTop: "18px" }}><h3>ملخص مالية الوسطاء</h3><Table rows={[["إجمالي الرفعات", money(report.finance.total) + " د.ع", "مالي", "مسجل"],["إجمالي المدفوع", money(report.finance.paid) + " د.ع", "مالي", "مستلم"],["إجمالي المتبقي", money(report.finance.total - report.finance.paid) + " د.ع", "مالي", "قيد التحصيل"]]} /></section>
      <p className="settings-saved">آخر تحديث: {new Date(report.generatedAt).toLocaleString("ar-IQ")}</p>
    </>}
  </div>;
}

function Assistants({ role }) {
  const [assistants, setAssistants] = useState([]); const [users, setUsers] = useState([]); const [userId, setUserId] = useState("");
  const [permissions, setPermissions] = useState(["REQUESTS", "COMPLAINTS"]); const [message, setMessage] = useState("");
  const available = [["REQUESTS", "الطلبات"], ["COMPLAINTS", "الشكاوى"], ["USERS", "المستخدمون"], ["FINANCE", "المالية"], ["ANNOUNCEMENTS", "الإعلانات"]];
  async function load() { try { const [assistantResult, userResult] = await Promise.all([api("/owner/assistants"), api("/owner/users")]); setAssistants(assistantResult.assistants || []); setUsers((userResult.users || []).filter((item) => item.role !== "OWNER" && item.role !== "OWNER_ASSISTANT")); } catch (error) { setMessage(error.message); } }
  useEffect(() => { load(); }, []);
  function toggle(value) { setPermissions((old) => old.includes(value) ? old.filter((item) => item !== value) : [...old, value]); }
  async function add() { if (!userId) return setMessage("اختر حسابًا أولًا."); try { await api("/owner/assistants", { method: "POST", body: JSON.stringify({ userId, permissions }) }); setUserId(""); setMessage("تم تعيين المساعد والصلاحيات."); load(); } catch (error) { setMessage(error.message); } }
  async function remove(id) { if (!window.confirm("إلغاء صلاحية هذا المساعد؟")) return; try { await api(`/owner/assistants/${id}`, { method: "DELETE" }); setMessage("تمت إزالة المساعد."); load(); } catch (error) { setMessage(error.message); } }
  return <div className="page"><Title t="المساعدون والصلاحيات" d="منح صلاحيات محددة دون مشاركة حساب Owner." i="◇" />
    {role === "OWNER" && <section className="panel"><h3>تعيين مساعد جديد</h3><select value={userId} onChange={(event) => setUserId(event.target.value)}><option value="">اختر المستخدم</option>{users.map((item) => <option key={item.id} value={item.id}>{item.telegram_name || item.telegram_username || "مستخدم"} • {item.account_type}</option>)}</select><div className="permission-grid">{available.map(([value, label]) => <label key={value}><input type="checkbox" checked={permissions.includes(value)} onChange={() => toggle(value)} /> {label}</label>)}</div><button className="primary" onClick={add}>تعيين كمساعد Owner</button></section>}
    <section className="panel" style={{ marginTop: "18px" }}><h3>المساعدون الحاليون</h3>{assistants.length ? assistants.map((assistant) => <article className="complaint-row" key={assistant.id}><b>{assistant.telegram_name || assistant.telegram_username || "مساعد"}</b><p>الصلاحيات: {(assistant.permissions || []).join("، ") || "بدون صلاحيات"}</p><small>الحالة: {assistant.status}</small>{role === "OWNER" && <button className="secondary" onClick={() => remove(assistant.id)}>إزالة المساعد</button>}</article>) : <p>لا يوجد مساعدون حاليًا.</p>}</section>{message && <p className="settings-saved">{message}</p>}
  </div>;
}

function AuditLog() {
  const [logs, setLogs] = useState([]); const [error, setError] = useState("");
  useEffect(() => { api("/owner/audit").then((result) => setLogs(result.logs || [])).catch((err) => setError(err.message)); }, []);
  return <div className="page"><Title t="سجل العمليات" d="تتبّع المراجعات والتغييرات الإدارية الأخيرة." i="◌" />{error && <p className="error">{error}</p>}<section className="panel">{logs.length ? logs.map((log) => <article className="complaint-row" key={log.id}><b>{log.action.replaceAll("_", " ")}</b><p>{log.telegram_name || log.telegram_username || "النظام"}{log.target_type ? ` • ${log.target_type}` : ""}{log.target_id ? ` • ${log.target_id.slice(0, 8)}` : ""}</p><small>{new Date(log.created_at).toLocaleString("ar-IQ")}</small></article>) : <p>لا توجد عمليات مسجلة بعد.</p>}</section></div>;
}

function SystemStatus() {
  const [system, setSystem] = useState(null); const [error, setError] = useState("");
  async function load() { setError(""); try { const result = await api("/owner/system"); setSystem(result.system); } catch (err) { setError(err.message); } }
  useEffect(() => { load(); }, []);
  return <div className="page"><Title t="حالة النظام" d="فحص مباشر للخادم وقاعدة البيانات." i="▦" />{error && <p className="error">{error}</p>}<section className="panel">{!system ? <p>جاري الفحص...</p> : <><div className="stats"><div className="stat"><small>واجهة API</small><strong>✓</strong><span>تعمل</span></div><div className="stat"><small>قاعدة البيانات</small><strong>✓</strong><span>{system.databaseLatencyMs} ms</span></div><div className="stat"><small>تخزين Telegram</small><strong>{system.telegramStorage === "CONFIGURED" ? "✓" : "!"}</strong><span>{system.telegramStorage === "CONFIGURED" ? "مُعد" : "غير مُعد"}</span></div><div className="stat"><small>وقت التشغيل</small><strong>{Math.floor(system.uptimeSeconds / 60)}</strong><span>دقيقة</span></div></div><p>وقت الخادم: {new Date(system.serverTime).toLocaleString("ar-IQ")}</p><button className="secondary" onClick={load}>إعادة الفحص</button></>}</section></div>;
}

function Backup({ role }) {
  const [backups, setBackups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [channelId, setChannelId] = useState("");
  const [savingChannel, setSavingChannel] = useState(false);
  const [message, setMessage] = useState("");

  async function load() {
    setLoading(true);
    try {
      const result = await api("/owner/backups");
      setBackups(result.backups || []);
      if (role === "OWNER") {
        const settings = await api("/owner/backup-settings");
        setChannelId(settings.channelId || "");
      }
    } catch (error) { setMessage(error.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function saveChannel() {
    if (!channelId.trim()) return setMessage("أدخل معرّف قناة النسخ الاحتياطي أولًا.");
    setSavingChannel(true); setMessage("");
    try {
      await api("/owner/backup-settings", { method: "PUT", body: JSON.stringify({ channelId: channelId.trim() }) });
      setMessage("تم حفظ قناة النسخ الاحتياطي بنجاح.");
    } catch (error) { setMessage(error.message); }
    finally { setSavingChannel(false); }
  }

  async function createBackup() {
    setCreating(true); setMessage("");
    try {
      const result = await api("/owner/backups", { method: "POST" });
      setMessage(`تم إنشاء النسخة وإرسالها إلى قناة Telegram. البصمة: ${String(result.backup.sha256_hash || "").slice(0, 12)}…`);
      await load();
    } catch (error) { setMessage(error.message); }
    finally { setCreating(false); }
  }

  return <div className="page">
    <Title t="النسخ الاحتياطي" d="نسخ فعلية مضغوطة من بيانات المنصة تُحفظ في قناة Telegram الخاصة." i="↻" />
    {role === "OWNER" && <section className="panel" style={{ marginBottom: "18px" }}>
      <h3>قناة النسخ الاحتياطي</h3>
      <p>أدخل معرّف القناة الخاصة بصيغة <bdi dir="ltr">-100...</bdi>. أضف البوت مشرفًا بالقناة قبل إنشاء النسخة.</p>
      <input value={channelId} onChange={(event) => setChannelId(event.target.value)} placeholder="-1001234567890" dir="ltr" />
      <button className="secondary" disabled={savingChannel} onClick={saveChannel}>{savingChannel ? "جاري الحفظ..." : "حفظ القناة"}</button>
    </section>}
    <section className="panel">
      <h3>نسخة احتياطية جديدة</h3>
      <p>يشمل النسخ المستخدمين والطلبات والمرفقات والمالية والشكاوى والإشعارات وسجل العمليات. لا تُنسخ الجلسات أو رموز الدخول.</p>
      {role === "OWNER" ? <button className="primary" disabled={creating} onClick={createBackup}>{creating ? "جاري إنشاء النسخة وإرسالها..." : "إنشاء نسخة احتياطية الآن"}</button> : <p>يمكنك مراجعة سجل النسخ الاحتياطية. إنشاء النسخ متاح لحساب Owner فقط.</p>}
      {message && <p className="settings-saved">{message}</p>}
    </section>
    <section className="panel" style={{ marginTop: "18px" }}>
      <h3>سجل النسخ الاحتياطية</h3>
      {loading ? <p>جاري تحميل السجل...</p> : <Table rows={backups.length ? backups.map((backup) => [
        backup.status === "SUCCESS" ? "نسخة مكتملة" : backup.status === "FAILED" ? "نسخة فشلت" : "قيد الإنشاء",
        backup.file_size ? `${(Number(backup.file_size) / 1024 / 1024).toFixed(2)} MB` : "—",
        new Date(backup.started_at).toLocaleString("ar-IQ"),
        backup.status === "SUCCESS" ? "تم الحفظ في Telegram" : backup.error_message || backup.status,
      ]) : [["لا توجد نسخ بعد", "—", "—", "—"]]} />}
    </section>
  </div>;
}

function Profile({ user }) {
  const [copied, setCopied] = useState(false);
  function copyId() { navigator.clipboard?.writeText(String(user.telegram_id || "")); setCopied(true); setTimeout(() => setCopied(false), 1600); }
  return (
    <div className="page">
      <Title
        t="ملفي الشخصي"
        d="بيانات الهوية المرتبطة بحساب Telegram الخاص بك."
        i="◎"
      />

      <section className="profile">
        <b>SA</b>

        <div>
          <h2>
            <bdi className="unicode-text">{user.telegram_name || "المستخدم"}</bdi>
          </h2>

          <p>
            @
            <bdi className="unicode-text">{user.telegram_username || "غير محدد"}</bdi>
          </p>

          <small>
            Telegram ID:{" "}
            {user.telegram_id}
          </small>
        </div>
      </section>

      <section className="panel" style={{ marginTop: "18px" }}>
        <h3>تفاصيل الحساب</h3>
        <Table rows={[
          ["نوع الحساب", meta[user.role === "OWNER" || user.role === "OWNER_ASSISTANT" ? user.role : user.account_type]?.[0] || user.account_type, "الصلاحية", user.role],
          ["حالة الحساب", user.status === "ACTIVE" ? "نشط" : user.status, "التحقق", user.is_verified ? "مؤكد" : "قيد التحقق"],
          ["تاريخ الانضمام", user.created_at ? new Date(user.created_at).toLocaleDateString("ar-IQ") : "—", "هوية Telegram", String(user.telegram_id || "—")],
        ]} />
        <button className="secondary" onClick={copyId}>{copied ? "تم نسخ المعرّف" : "نسخ معرّف Telegram"}</button>
      </section>
    </div>
  );
}

function Settings({ dark, setDark, user }) {
  const [compact, setCompact] = useState(localStorage.getItem("sa_compact") === "true");
  const [message, setMessage] = useState("");
  const [setupKey, setSetupKey] = useState("");
  const [claiming, setClaiming] = useState(false);
  function toggleCompact() {
    const value = !compact;
    setCompact(value);
    localStorage.setItem("sa_compact", String(value));
    setMessage("تم حفظ الإعداد على هذا الجهاز.");
  }
  async function claimOwner() {
    if (!setupKey.trim()) return setMessage("اكتب رمز إعداد Owner أولًا.");
    setClaiming(true);
    try {
      await api("/auth/claim-owner", { method: "POST", body: JSON.stringify({ setupKey: setupKey.trim() }) });
      setMessage("تم ربط الحساب كـ Owner. أعد فتح المنصة لتظهر لوحة Owner.");
      setSetupKey("");
    } catch (error) { setMessage(error.message); } finally { setClaiming(false); }
  }
  return <div className="page">
    <Title t="الإعدادات" d="خصّص تجربة استخدامك للمنصة." i="⚙" />
    <section className="settings-card">
      <div className="setting-item"><div><b>الوضع الليلي</b><span>تبديل ألوان المنصة على هذا الجهاز.</span></div><button className={dark ? "toggle on" : "toggle"} onClick={() => { setDark(!dark); setMessage("تم تحديث المظهر."); }}><i /></button></div>
      <div className="setting-item"><div><b>العرض المختصر</b><span>حفظ تفضيل الواجهة على هذا الجهاز.</span></div><button className={compact ? "toggle on" : "toggle"} onClick={toggleCompact}><i /></button></div>
      <div className="setting-item static"><div><b>حماية الحساب</b><span>يتم تسجيل الدخول بواسطة هوية Telegram فقط.</span></div><strong>محمي</strong></div>
    </section>
    {user.role !== "OWNER" && <section className="settings-card owner-setup">
      <div><b>ربط حساب Owner</b><span>يُستخدم مرة واحدة لربط حساب Telegram الحالي بمالك المنصة.</span></div>
      <input type="password" value={setupKey} onChange={(event) => setSetupKey(event.target.value)} placeholder="رمز إعداد Owner" />
      <button className="primary" disabled={claiming} onClick={claimOwner}>{claiming ? "جاري الربط..." : "ربط هذا الحساب كـ Owner"}</button>
    </section>}
    {message && <p className="settings-saved">✓ {message}</p>}
  </div>;
}

function Basic({ title, icon }) {
  return (
    <div className="page">
      <Title
        t={title}
        d="لا تملك صلاحية الوصول إلى هذا القسم."
        i={icon}
      />

      <section className="panel">
        <h3>وصول غير متاح</h3>
        <p>هذه الصفحة لا تحتوي بيانات تجريبية. استخدم الأقسام المتاحة لحسابك من القائمة الجانبية.</p>
      </section>
    </div>
  );
}

function Table({ rows }) {
  return (
    <div className="table">
      <div className="tr head">
        <span>العنصر</span>
        <span>النوع</span>
        <span>التاريخ</span>
        <span>الحالة</span>
      </div>

      {rows.map((row, index) => (
        <div
          className="tr"
          key={index}
        >
          {row.map((value, valueIndex) => (
            <span key={valueIndex}>
              {value}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

createRoot(
  document.getElementById("root")
).render(<App />);
