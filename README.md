# 🔐 Keyra

**Keyra**, modern, çevrimdışı, sıfır sunucu ve donanımsal C hızlandırmalı bir KeePass (`.kdbx`) şifre yöneticisidir.

---

## ✨ Özellikler

- **🔒 %100 Çevrimdışı & Güvenli:** Verileriniz asla bir sunucuya gönderilmez. Standart AES-256 ve Argon2 KDF ile cihazınızda şifrelenir.
- **⚡ Donanımsal C/NDK Hızlandırma:** KeePassXC 64 MB Argon2d / Argon2id anahtar çözümleri telefonun donanım çekirdeklerinde milisaniyeler içinde açılır.
- **📁 KeePass / KeePassXC Tam Uyumluluğu:** Masaüstündeki `.kdbx` dosyalarınızı doğrudan açabilir, düzenleyebilir ve dışa aktarabilirsiniz.
- **👆 Biyometrik Giriş:** Parmak İzi ve FaceID ile kasaya tek dokunuşla güvenli erişim.
- **🎲 Gelişmiş Şifre Üreticisi:** Uzunluk, büyük/küçük harf, rakam ve özel karakter filtreli kriptografik parola motoru.
- **📋 Güvenli Pano (Auto-Clear):** Kopyalanan şifreler 30 saniye sonra sistem panosundan otomatik olarak temizlenir.
- **🌗 Modern Minimalist Arayüz:** Sade, akıcı ve koyu tema odaklı tasarım.

---

## 🛠️ Teknoloji Yığını

- **Framework:** [React Native](https://reactnative.dev/) (Expo SDK 58, React 19)
- **Kriptografi & KDBX:** [kdbxweb](https://github.com/keeweb/kdbxweb), [expo-argon2](https://github.com/sonnetstationsolutions/expo-argon2) (Native C bindings)
- **Güvenli Depolama:** Expo SecureStore
- **Biyometri:** Expo LocalAuthentication
- **Dil:** TypeScript

---

## 🚀 Başlangıç

Projeyi yerel ortamınızda çalıştırmak için:

```bash
# Bağımlılıkları yükleyin
npm install

# Geliştirme sunucusunu başlatın
npx expo start
```

Android APK derlemesi almak için:

```bash
npx eas-cli build -p android --profile preview
```

---

## 📄 Lisans

MIT License © 2026 [kayradivrik](https://github.com/kayradivrik)
