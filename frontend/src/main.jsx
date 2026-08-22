import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

const API =
  import.meta.env.VITE_API_URL || "http://localhost:4000/api";

const meta = {
  MEMBER: ["عضو", "◉"],
  ADMIN: ["ADMIN", "◆"],
  BROKER: ["وسيط", "▣"],
  OWNER: ["OWNER", "♛"],
  OWNER_ASSISTANT: ["مساعد Owner", "◇"],
};

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
    <div className={dark ? "shell dark" : "shell"}>
      <Side
        role={role}
        page={page}
        setPage={setPage}
        logout={logout}
      />

      <main>
        <header>
          <div>
            <small>Super Amazon / لوحة التحكم</small>
            <h1>
              مرحبًا، {user.telegram_name || "بك"} 👋
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
        <b>SA</b>
        <small>PLATFORM • 2026</small>

        <h1>
          SUPER
          <br />
          <span>AMAZON</span>
        </h1>

        <p>
          منصة موحدة للأعضاء والـ ADMIN والوسطاء
          بإدارة Owner مركزية وآمنة.
        </p>

        <p>◈ هوية Telegram</p>
        <p>◈ طلبات تحقق ومراجعة</p>
        <p>◈ مالية وشكاوى وإشعارات</p>
      </section>

      <section className="loginbox">
        <small>● بوابة الدخول</small>

        <h2>ابدأ من Telegram</h2>

        <p>يتم إنشاء حساب عضو بعد تأكيد هويتك، ثم يمكنك تقديم طلب ترقية إلى ADMIN أو BROKER.</p>

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
}) {
  const items = [
    ["home", "الرئيسية", "⌂"],
  ];

  if (role === "MEMBER") {
    items.push([
      "application",
      "طلب ADMIN أو BROKER",
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
    ]);
  }

  if (role === "BROKER") {
    items.push(
      ["application", "حالة الطلب", "▣"],
      ["finance", "المالية", "₿"],
      ["payments", "الدفعات", "↗"],
      ["receipts", "الإيصالات", "▧"]
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
    <aside>
      <div className="logo">
        <b>SA</b>

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

        <button onClick={logout}>
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
    return <Finance />;
  }

  if (page === "payments") {
    return (
      <Basic
        title="الدفعات"
        icon="↗"
      />
    );
  }

  if (page === "receipts") {
    return (
      <Basic
        title="الإيصالات"
        icon="▧"
      />
    );
  }

  if (page === "users") {
    return <Users />;
  }

  if (page === "requests") {
    return <Requests />;
  }

  if (page === "reports") {
    return (
      <Basic
        title="التقارير"
        icon="▥"
      />
    );
  }

  if (page === "assistants") {
    return (
      <Basic
        title="المساعدون والصلاحيات"
        icon="◇"
      />
    );
  }

  if (page === "audit") {
    return (
      <Basic
        title="سجل العمليات"
        icon="◌"
      />
    );
  }

  if (page === "backup") {
    return <Backup />;
  }

  if (page === "system") {
    return (
      <Basic
        title="حالة النظام"
        icon="▦"
      />
    );
  }

  if (page === "profile") {
    return <Profile user={user} />;
  }

  if (page === "settings") {
    return <Settings dark={dark} setDark={setDark} />;
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

  const cards = owner
    ? [
        [
          "إجمالي المستخدمين",
          "1,248",
          "+8.4%",
        ],
        [
          "الطلبات الجديدة",
          "26",
          "تحتاج مراجعة",
        ],
        [
          "الشكاوى المفتوحة",
          "14",
          "3 عاجلة",
        ],
        [
          "تمويل الوسطاء",
          "18.4M",
          "د.ع هذا الشهر",
        ],
      ]
    : role === "BROKER"
    ? [
        [
          "سعر الرفعة",
          "750,000",
          "د.ع",
        ],
        [
          "المدفوع",
          "500,000",
          "د.ع",
        ],
        [
          "المتبقي",
          "250,000",
          "د.ع",
        ],
        [
          "التمويل الشهري",
          "750,000",
          "د.ع",
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
          "03",
          "غير مقروءة",
        ],
        [
          "القوانين",
          "05",
          "تحديثات جديدة",
        ],
        [
          "الدعم",
          "24/7",
          "تواصل معنا",
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
      ]
    : role === "MEMBER"
    ? [
        [
          "طلب ADMIN أو BROKER",
          "قدّم طلب ترقية حسابك",
          "application",
        ],
        [
          "تقديم شكوى",
          "اختر ADMIN أو BROKER",
          "complaints",
        ],
      ]
    : role === "BROKER" ||
      role === "ADMIN"
    ? [
        [
          "حالة الطلب",
          "تابع طلبك",
          "application",
        ],
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
      alert("اكتب رقم المستمسك");
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
            ADMIN
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
            BROKER
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
          رقم المستمسك
        </label>

        <input
          value={nationalId}
          onChange={(e) =>
            setNationalId(
              e.target.value
            )
          }
          placeholder="رقم المستمسك"
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
                  {type}
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

  return (
    <div className="page">
      <Title t="الإشعارات" d="تابع آخر تحديثات حسابك وطلباتك." i="◉" />
      <section className="notification-toolbar">
        <div><b>{items.filter((item) => !item.is_read).length}</b><span>إشعارات غير مقروءة</span></div>
        <button className="secondary" onClick={markAllRead}>تحديد الكل كمقروء</button>
      </section>
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

  async function loadComplaints() {
    try {
      const result = await api("/owner/complaints");
      setItems(result.complaints || []);
    } catch (error) { alert(error.message); } finally { setLoading(false); }
  }
  useEffect(() => { loadComplaints(); }, []);

  async function review(item, status) {
    const note = prompt("ملاحظة الإدارة للمستخدم (اختياري):", item.owner_note || "");
    if (note === null) return;
    try {
      await api(`/owner/complaints/${item.id}`, { method: "PATCH", body: JSON.stringify({ status, note }) });
      await loadComplaints();
    } catch (error) { alert(error.message); }
  }

  return (
    <div className="page">
      <Title t="إدارة الشكاوى" d="راجع الشكاوى وحدّث حالتها." i="⚑" />
      <section className="panel">
        {loading ? <p>جاري التحميل...</p> : items.length === 0 ? <p>لا توجد شكاوى.</p> : items.map((item) => (
          <div className="complaint-row" key={item.id}>
            <b>{item.target_type} • {item.status}</b>
            <span>من: {item.complainant_name || "—"} | ضد: {item.target_name || "—"}</span>
            <p>{item.body}</p>
            {item.owner_note && <small>ملاحظة سابقة: {item.owner_note}</small>}
            <div className="inline-actions">
              <button onClick={() => review(item, "UNDER_REVIEW")}>قيد المراجعة</button>
              <button onClick={() => review(item, "RESOLVED")}>حل الشكوى</button>
              <button onClick={() => review(item, "REJECTED")}>رفض</button>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

function Requests() {
  const [data, setData] =
    useState([]);

  const [loading, setLoading] =
    useState(true);

  useEffect(() => {
    loadRequests();
  }, []);

  async function loadRequests() {
    try {
      const result = await api(
        "/owner/requests"
      );

      setData(
        result.requests || []
      );
    } catch (error) {
      alert(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function review(
    id,
    decision
  ) {
    const note = prompt(
      decision ===
        "NEEDS_CORRECTION"
        ? "حدد النقص أو الخطأ:"
        : "ملاحظة المراجعة:",
      ""
    );

    if (note === null) return;

    try {
      await api(
        `/owner/requests/${id}/review`,
        {
          method: "PATCH",
          body: JSON.stringify({
            decision,
            note,
          }),
        }
      );

      await loadRequests();

      alert(
        "تم تحديث الطلب"
      );
    } catch (error) {
      alert(error.message);
    }
  }

  return (
    <div className="page">
      <Title
        t="طلبات التقديم"
        d="مراجعة طلبات ADMIN وBROKER."
        i="✓"
      />

      <section className="panel">
        {loading ? (
          <p>جاري التحميل...</p>
        ) : (
          <div className="table">
            <div className="tr head">
              <span>
                الطلب
              </span>

              <span>
                المتقدم
              </span>

              <span>
                النوع
              </span>

              <span>
                الحالة / الإجراء
              </span>
            </div>

            {data.map((item) => (
              <div
                className="tr"
                key={item.id}
              >
                <span>
                  #{item.request_number}
                </span>

                <span>
                  {item.full_name}
                  <br />
                  <small>
                    @
                    {item.telegram_username ||
                      "—"}
                  </small>
                </span>

                <span>
                  {item.applicant_type}
                </span>

                <span>
                  {item.status}
                  <br />

                  <button
                    onClick={() =>
                      review(
                        item.id,
                        "APPROVED"
                      )
                    }
                  >
                    موافقة
                  </button>

                  <button
                    onClick={() =>
                      review(
                        item.id,
                        "NEEDS_CORRECTION"
                      )
                    }
                  >
                    نقص/خطأ
                  </button>

                  <button
                    onClick={() =>
                      review(
                        item.id,
                        "REJECTED_FINAL"
                      )
                    }
                  >
                    رفض نهائي
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
                  {user.telegram_name ||
                    "—"}
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

function Finance() {
  const [data, setData] = useState({ summary: { total: 0, paid: 0, remaining: 0 }, payments: [] });
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    api("/finance/me").then((result) => setData({ summary: result.summary, payments: result.payments || [] }))
      .catch((error) => alert(error.message)).finally(() => setLoading(false));
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

function Backup() {
  return (
    <div className="page">
      <Title
        t="النسخ الاحتياطي"
        d="مركز النسخ الاحتياطي اليومي إلى Telegram."
        i="↻"
      />

      <section className="backup">
        <h3>
          ✓ آخر نسخة ناجحة
        </h3>

        <strong>
          اليوم • 03:00
        </strong>

        <p>
          النسخة سليمة ومشفرة
        </p>

        <div className="stats">
          <div>
            <small>الحجم</small>
            <b>184 MB</b>
          </div>

          <div>
            <small>SHA-256</small>
            <b>••••••••</b>
          </div>

          <div>
            <small>القناة</small>
            <b>
              محددة من Owner
            </b>
          </div>
        </div>

        <button className="primary">
          إنشاء نسخة اختبارية
        </button>
      </section>
    </div>
  );
}

function Profile({ user }) {
  return (
    <div className="page">
      <Title
        t="ملفي الشخصي"
        d="معلومات حسابك الأساسية."
        i="◎"
      />

      <section className="profile">
        <b>SA</b>

        <div>
          <h2>
            {user.telegram_name ||
              "المستخدم"}
          </h2>

          <p>
            @
            {user.telegram_username ||
              "غير محدد"}
          </p>

          <small>
            Telegram ID:{" "}
            {user.telegram_id}
          </small>
        </div>
      </section>
    </div>
  );
}

function Settings({ dark, setDark }) {
  const [compact, setCompact] = useState(localStorage.getItem("sa_compact") === "true");
  const [message, setMessage] = useState("");
  function toggleCompact() {
    const value = !compact;
    setCompact(value);
    localStorage.setItem("sa_compact", String(value));
    setMessage("تم حفظ الإعداد على هذا الجهاز.");
  }
  return <div className="page">
    <Title t="الإعدادات" d="خصّص تجربة استخدامك للمنصة." i="⚙" />
    <section className="settings-card">
      <div className="setting-item"><div><b>الوضع الليلي</b><span>تبديل ألوان المنصة على هذا الجهاز.</span></div><button className={dark ? "toggle on" : "toggle"} onClick={() => { setDark(!dark); setMessage("تم تحديث المظهر."); }}><i /></button></div>
      <div className="setting-item"><div><b>العرض المختصر</b><span>حفظ تفضيل الواجهة على هذا الجهاز.</span></div><button className={compact ? "toggle on" : "toggle"} onClick={toggleCompact}><i /></button></div>
      <div className="setting-item static"><div><b>حماية الحساب</b><span>يتم تسجيل الدخول بواسطة هوية Telegram فقط.</span></div><strong>محمي</strong></div>
    </section>
    {message && <p className="settings-saved">✓ {message}</p>}
  </div>;
}

function Basic({ title, icon }) {
  return (
    <div className="page">
      <Title
        t={title}
        d="هذا القسم مصمم للربط مع خدمات النظام وقاعدة البيانات."
        i={icon}
      />

      <section className="panel">
        <h3>{title}</h3>

        <Table
          rows={[
            [
              "بيانات تجريبية",
              "جاهز للربط",
              "—",
              "—",
            ],
            [
              "—",
              "—",
              "—",
              "—",
            ],
          ]}
        />
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
