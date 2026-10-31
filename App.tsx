import './polyfills';
import { Buffer } from 'buffer';
import React, {
  useState,
  useMemo,
  useRef,
  useEffect,
  useCallback,
} from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  FlatList,
  ScrollView,
  Modal,
  KeyboardAvoidingView,
  Keyboard,
  Platform,
  Alert,
  ActivityIndicator,
  AppState,
  AppStateStatus,
  Linking,
  StatusBar as RNStatusBar,
  Image,
  Switch,
  Animated,
  Easing,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { Ionicons, Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import * as Clipboard from 'expo-clipboard';
import * as ScreenCapture from 'expo-screen-capture';
import QRCode from 'react-native-qrcode-svg';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { googleDriveSync, GoogleSyncState } from './services/GoogleDriveSyncService';
import { qrSync, QrSyncPayload } from './services/QrSyncService';
import { webConnectService } from './services/WebConnectService';
import { breachCheckerService } from './services/BreachCheckerService';
import {
  AuthScreenMode,
  EntryCategory,
  FILTERS,
  VaultEntry,
  VaultState,
} from './types/kdbx';
import {
  kdbxService,
  deriveMonogram,
  formatVaultFileName,
} from './services/KdbxService';

declare const global: {
  Buffer?: typeof Buffer;
  [key: string]: unknown;
};

global.Buffer = Buffer;

const COLORS = {
  background: '#08090C',        // Saf obsidian grafit zemin
  foreground: '#FFFFFF',        // %100 saf beyaz başlıklar
  card: '#111218',              // Dokunsal mat kart zemini
  cardHighlight: '#161720',
  surface: '#151620',           // Form & Input arka planı
  surfaceLight: '#1B1D28',
  primary: '#FFFFFF',           // Monochromatic Contrast Primary Action (Apple/Linear standardı)
  primaryHover: '#E5E7EB',
  primaryForeground: '#08090C', // Saf beyaz buton üzerinde keskin koyu yazı
  accent: '#E4E4E7',            // Titanyum açık gri
  cyanAccent: '#38BDF8',        // Canlı Cyan
  emerald: '#10B981',           // Başarı & Güçlü Şifre
  amber: '#F59E0B',             // Orta Şifre / Uyarı
  dangerRed: '#EF4444',         // Hata & Silme
  destructive: '#EF4444',
  mutedForeground: '#8E92A4',   // Doğal, yormayan gümüş-gri
  subtleText: '#55596D',        // Kılavuz / placeholder metin
  border: 'rgba(255, 255, 255, 0.07)', // Saç teli inceliğinde zarif kenarlık
  borderActive: 'rgba(255, 255, 255, 0.22)',
};

const MONO_FONT = Platform.OS === 'ios' ? 'Menlo' : 'monospace';
const CLIPBOARD_CLEAR_MS = 30000;

const MONOGRAM_PALETTES = [
  { bg: 'rgba(255, 255, 255, 0.08)', text: '#FFFFFF', border: 'rgba(255, 255, 255, 0.16)' }, // Titanium White
  { bg: 'rgba(16, 185, 129, 0.12)', text: '#34D399', border: 'rgba(16, 185, 129, 0.25)' }, // Emerald
  { bg: 'rgba(56, 189, 248, 0.12)', text: '#38BDF8', border: 'rgba(56, 189, 248, 0.25)' }, // Sky
  { bg: 'rgba(245, 158, 11, 0.12)', text: '#FBBF24', border: 'rgba(245, 158, 11, 0.25)' }, // Amber
  { bg: 'rgba(148, 163, 184, 0.12)', text: '#CBD5E1', border: 'rgba(148, 163, 184, 0.25)' }, // Slate Steel
  { bg: 'rgba(244, 63, 94, 0.12)',  text: '#FB7185', border: 'rgba(244, 63, 94, 0.25)' }, // Rose
];

function getMonogramStyle(str: string) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return MONOGRAM_PALETTES[Math.abs(hash) % MONOGRAM_PALETTES.length];
}

const triggerHaptic = (type: 'light' | 'medium' | 'success' | 'error' = 'light') => {
  try {
    if (type === 'light') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    else if (type === 'medium') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    else if (type === 'success') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    else if (type === 'error') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  } catch {
    // Platform bazlı hata yoksayılır
  }
};

function scorePassword(value: string): number {
  let score = 0;
  if (value.length >= 8) score++;
  if (value.length >= 14) score++;
  if (/[A-Z]/.test(value) && /[a-z]/.test(value)) score++;
  if (/\d/.test(value) && /[^A-Za-z0-9]/.test(value)) score++;
  return Math.min(score, 4);
}

const STRENGTH_LABELS = ['Boş', 'Zayıf', 'Orta', 'Güçlü', 'Kırılmaz'];
const STRENGTH_COLORS = ['#55596D', '#EF4444', '#F59E0B', '#10B981', '#34D399'];
const GENERATOR_LENGTHS = [12, 16, 24, 32] as const;

// ==========================================
// KAYIT KARTI BİLEŞENİ
// ==========================================
interface EntryCardProps {
  entry: VaultEntry;
  onCopyText: (value: string, label: string) => void;
  onOpenDetail: (entry: VaultEntry) => void;
}

const EntryCardItem = React.memo(function EntryCardItem({
  entry,
  onCopyText,
  onOpenDetail,
}: EntryCardProps) {
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = (e: any) => {
    e?.stopPropagation?.();
    triggerHaptic('success');
    onCopyText(entry.password, `${entry.title} şifresi`);
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  };

  const monogram = entry.monogram || deriveMonogram(entry.title);
  const palette = getMonogramStyle(entry.title);

  // URL'den alan adını temiz çıkarma (örn. https://accounts.google.com -> google.com)
  const displayHost = useMemo(() => {
    if (!entry.url) return null;
    try {
      const u = entry.url.replace(/^https?:\/\//i, '').split('/')[0];
      return u.replace(/^www\./i, '');
    } catch {
      return null;
    }
  }, [entry.url]);

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={`${entry.title} kaydı. ${entry.username ? `Kullanıcı adı: ${entry.username}` : ''}`}
      accessibilityHint="Kayıt detaylarını görüntülemek için dokunun"
      onPress={() => {
        triggerHaptic('light');
        onOpenDetail(entry);
      }}
      style={styles.entryCard}
    >
      <View
        style={[
          styles.monogramBox,
          {
            backgroundColor: palette.bg,
            borderColor: palette.border,
          },
        ]}
      >
        <Text style={[styles.monogramText, { color: palette.text }]}>
          {monogram}
        </Text>
      </View>

      <View style={styles.entryCenter}>
        <View style={styles.entryTitleRow}>
          <Text style={styles.entryTitle} numberOfLines={1}>
            {entry.title}
          </Text>
          {displayHost ? (
            <View style={styles.entryHostBadgeWrap}>
              <Text style={styles.entryHostBadge} numberOfLines={1}>
                {displayHost}
              </Text>
            </View>
          ) : null}
        </View>

        <Text style={styles.entrySubtitle} numberOfLines={1}>
          {entry.username || (entry.category === 'logins' ? 'Giriş Hesabı' : entry.category) || 'Kayıt'}
        </Text>
      </View>

      <View style={styles.entryRightActions}>
        <TouchableOpacity
          onPress={handleCopy}
          activeOpacity={0.65}
          accessibilityRole="button"
          accessibilityLabel={`${entry.title} şifresini panoya kopyala`}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={[styles.quickCopyButton, copied && styles.quickCopyButtonCopied]}
        >
          <Ionicons
            name={copied ? 'checkmark' : 'copy-outline'}
            size={16}
            color={copied ? COLORS.emerald : COLORS.mutedForeground}
          />
        </TouchableOpacity>

        <Ionicons
          name="chevron-forward"
          size={14}
          color="rgba(255, 255, 255, 0.2)"
          style={{ marginLeft: 6 }}
        />
      </View>
    </TouchableOpacity>
  );
});

// ==========================================
// ANA UYGULAMA (App.tsx)
// ==========================================
export default function App() {
  const [vaultState, setVaultState] = useState<VaultState>({
    isUnlocked: false,
    filePath: null,
    fileName: kdbxService.getActiveFileName(),
    ownerName: '',
    entries: [],
  });

  const [authMode, setAuthMode] = useState<AuthScreenMode>('welcome');
  const [ownerNameInput, setOwnerNameInput] = useState<string>('');
  const [customVaultName, setCustomVaultName] =
    useState<string>('Personal.kdbx');
  const [knownVaults, setKnownVaults] = useState<string[]>([]);

  // Güvenlik & Biyometrik Durumları
  const [autoLockOnBackground, setAutoLockOnBackground] =
    useState<boolean>(true);
  const [biometricSupported, setBiometricSupported] = useState<boolean>(false);
  const [biometricEnabledForActive, setBiometricEnabledForActive] =
    useState<boolean>(false);
  const [saveBiometricOnAuth, setSaveBiometricOnAuth] =
    useState<boolean>(false);
  const [screenSecurityEnabled, setScreenSecurityEnabled] =
    useState<boolean>(true);
  const [isCheckingBreach, setIsCheckingBreach] = useState<boolean>(false);

  // Şifre Giriş State'leri
  const [password, setPassword] = useState<string>('');
  const [confirmPassword, setConfirmPassword] = useState<string>('');
  const [visiblePassword, setVisiblePassword] = useState<boolean>(false);
  const [authStatus, setAuthStatus] = useState<
    'idle' | 'deriving' | 'unlocked'
  >('idle');
  const [derivingProgress, setDerivingProgress] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Kasa İçi Arama ve Filtreleme
  const [query, setQuery] = useState<string>('');
  const [filter, setFilter] = useState<'all' | EntryCategory>('all');

  // Toast ve Pano Temizleyici Zamanlayıcıları
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clipboardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSystemDialogOpenRef = useRef<boolean>(false);

  // Seçili Kayıt ve Detay Modalı
  const [selectedEntry, setSelectedEntry] = useState<VaultEntry | null>(null);
  const [detailModalOpen, setDetailModalOpen] = useState<boolean>(false);
  const [detailPasswordVisible, setDetailPasswordVisible] =
    useState<boolean>(false);

  // Ayarlar & Ana Şifre Değiştirme State'leri
  const [settingsModalOpen, setSettingsModalOpen] = useState<boolean>(false);
  const [changePwSectionOpen, setChangePwSectionOpen] =
    useState<boolean>(false);
  const [currentMasterPwInput, setCurrentMasterPwInput] = useState<string>('');
  const [newMasterPwInput, setNewMasterPwInput] = useState<string>('');
  const [confirmNewMasterPwInput, setConfirmNewMasterPwInput] =
    useState<string>('');

  // Kayıt Ekleme / Düzenleme Modalı & Özelleştirilebilir Şifre Üretici
  const [addModalOpen, setAddModalOpen] = useState<boolean>(false);
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState<string>('');
  const [newUsername, setNewUsername] = useState<string>('');
  const [newPassword, setNewPassword] = useState<string>('');
  const [newUrl, setNewUrl] = useState<string>('');
  const [newNotes, setNewNotes] = useState<string>('');
  const [newCategory, setNewCategory] = useState<EntryCategory>('logins');
  const [isSaving, setIsSaving] = useState<boolean>(false);

  // Şifre Üretici Parametreleri
  const [genLength, setGenLength] = useState<number>(16);
  const [genIncludeNumbers, setGenIncludeNumbers] = useState<boolean>(true);
  const [genIncludeSymbols, setGenIncludeSymbols] = useState<boolean>(true);

  // Senkronizasyon (Google Drive & QR Sync) State'leri
  const [gdriveState, setGdriveState] = useState<GoogleSyncState>({
    isConnected: false,
    email: null,
    lastSyncTime: null,
    isSyncing: false,
    error: null,
  });
  const [googleTokenInput, setGoogleTokenInput] = useState<string>('');
  const [showTokenInput, setShowTokenInput] = useState<boolean>(false);
  const [qrModalOpen, setQrModalOpen] = useState<boolean>(false);
  const [qrPayloadString, setQrPayloadString] = useState<string>('');
  const [qrPairingPin, setQrPairingPin] = useState<string>('');
  const [scannerModalOpen, setScannerModalOpen] = useState<boolean>(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();

  // Akıcı Mikro-Animasyonlar & Odaklanma State'leri
  const heroFadeAnim = useRef(new Animated.Value(0)).current;
  const heroScaleAnim = useRef(new Animated.Value(0.94)).current;
  const shakeAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const [passwordFocused, setPasswordFocused] = useState<boolean>(false);
  const isScanningRef = useRef<boolean>(false);

  const triggerShake = useCallback(() => {
    shakeAnim.setValue(0);
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 10, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -10, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 7, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -7, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 3, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 50, useNativeDriver: true }),
    ]).start();
  }, [shakeAnim]);

  const showToast = useCallback((msg: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToastMessage(msg);
    toastTimerRef.current = setTimeout(() => setToastMessage(null), 2400);
  }, []);

  const refreshBiometricState = useCallback(async (vaultFile?: string) => {
    try {
      const [supported, enabled] = await Promise.all([
        kdbxService.isBiometricSupported(),
        kdbxService.isBiometricEnabledForVault(vaultFile),
      ]);
      setBiometricSupported(supported);
      const isAvailable = Boolean(supported && enabled);
      setBiometricEnabledForActive(isAvailable);
      setSaveBiometricOnAuth(isAvailable);
    } catch {
      setBiometricSupported(false);
      setBiometricEnabledForActive(false);
      setSaveBiometricOnAuth(false);
    }
  }, []);

  // Kasayı Kilitle (lockVault + panoyu temizle)
  const handleLock = useCallback(
    (silent: boolean = false) => {
      kdbxService.lockVault();
      if (clipboardTimerRef.current) {
        clearTimeout(clipboardTimerRef.current);
        clipboardTimerRef.current = null;
      }
      Clipboard.setStringAsync('').catch(() => {});

      setAuthStatus('idle');
      setPassword('');
      setConfirmPassword('');
      setQuery('');
      setAddModalOpen(false);
      setEditingEntryId(null);
      setDetailModalOpen(false);
      setDetailPasswordVisible(false);
      setSettingsModalOpen(false);
      setChangePwSectionOpen(false);
      setSelectedEntry(null);
      setAuthMode('unlock');
      setVaultState((prev) => ({
        ...prev,
        isUnlocked: false,
        filePath: null,
        entries: [],
      }));

      if (!silent) {
        showToast('Kasa kilitlendi');
      }
    },
    [showToast]
  );

  // Başlangıçta profil, biyometrik durumu ve giriş animasyonlarını başlat
  useEffect(() => {
    Animated.parallel([
      Animated.timing(heroFadeAnim, {
        toValue: 1,
        duration: 450,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.spring(heroScaleAnim, {
        toValue: 1,
        friction: 8,
        tension: 40,
        useNativeDriver: true,
      }),
    ]).start();

    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.025,
          duration: 1600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1.0,
          duration: 1600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    );
    pulseLoop.start();

    (async () => {
      try {
        const profile = await kdbxService.loadProfile();
        setOwnerNameInput(profile.ownerName);
        setKnownVaults(profile.knownVaults);
        setAutoLockOnBackground(profile.autoLockOnBackground);
        setCustomVaultName(
          profile.ownerName
            ? formatVaultFileName(profile.ownerName)
            : profile.activeVaultFile
        );
        setVaultState((prev) => ({
          ...prev,
          ownerName: profile.ownerName,
          fileName: profile.activeVaultFile,
        }));
        if (profile.knownVaults && profile.knownVaults.length > 0) {
          setAuthMode('unlock');
        }
        await refreshBiometricState(profile.activeVaultFile);
        const gState = await googleDriveSync.loadState();
        setGdriveState(gState);
      } catch {
        // Varsayılan değerlerle devam et
      }
    })();

    return () => {
      pulseLoop.stop();
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      if (clipboardTimerRef.current) clearTimeout(clipboardTimerRef.current);
    };
  }, [refreshBiometricState, heroFadeAnim, heroScaleAnim, pulseAnim]);

  // Arka Plana Atınca Otomatik Kilitleme (AppState Dinleyicisi)
  useEffect(() => {
    const subscription = AppState.addEventListener(
      'change',
      (nextState: AppStateStatus) => {
        if (
          nextState === 'background' &&
          vaultState.isUnlocked &&
          autoLockOnBackground &&
          !isSystemDialogOpenRef.current &&
          !scannerModalOpen
        ) {
          handleLock(true);
        }
      }
    );

    return () => {
      subscription.remove();
    };
  }, [vaultState.isUnlocked, autoLockOnBackground, handleLock, scannerModalOpen]);

  // Ekran Görüntüsü & Kayıt Koruması (Anti-Spy / FLAG_SECURE)
  useEffect(() => {
    if (screenSecurityEnabled && vaultState.isUnlocked) {
      ScreenCapture.preventScreenCaptureAsync().catch(() => {});
    } else {
      ScreenCapture.allowScreenCaptureAsync().catch(() => {});
    }
  }, [screenSecurityEnabled, vaultState.isUnlocked]);

  // 30 Saniyede Otomatik Temizlenen Pano Kopyalama Fonksiyonu
  const handleCopyText = useCallback(async (value: string, label: string) => {
    await Clipboard.setStringAsync(value);
    showToast(`${label} kopyalandı (30sn sonra silinir)`);

    if (clipboardTimerRef.current) {
      clearTimeout(clipboardTimerRef.current);
    }
    clipboardTimerRef.current = setTimeout(async () => {
      try {
        await Clipboard.setStringAsync('');
        showToast('Pano güvenlik için temizlendi');
      } catch {
        // Ignore
      }
      clipboardTimerRef.current = null;
    }, CLIPBOARD_CLEAR_MS);
  }, [showToast]);

  const handleOpenDetail = useCallback((target: VaultEntry) => {
    setSelectedEntry(target);
    setDetailPasswordVisible(false);
    setDetailModalOpen(true);
  }, []);

  // HaveIBeenPwned k-Anonymity Sızıntı Kontrolü (Sıfır-Bilgi Güvenliği)
  const handleCheckBreach = useCallback(async (pw: string, title?: string) => {
    triggerHaptic('light');
    setIsCheckingBreach(true);
    try {
      const res = await breachCheckerService.checkPassword(pw);
      triggerHaptic(res.isPwned ? 'error' : 'success');
      if (res.isPwned) {
        Alert.alert(
          'Sızıntı Uyarısı!',
          `"${title || 'Bu'}" kaydının şifresi bilinen veri sızıntılarında ${res.breachCount.toLocaleString()} kez ele geçirilmiş!\n\nHesabınızın güvenliği için bu şifreyi derhal değiştirmenizi öneririz.`,
          [{ text: 'Tamam', style: 'destructive' }]
        );
      } else {
        Alert.alert(
          'Şifre Güvende',
          `"${title || 'Bu'}" şifresi bilinen hiçbir sızıntı veritabanında yer almıyor.\n\nK-Anonymity kriptografik taraması başarıyla tamamlandı. Şifreniz tamamen gizli kaldı.`,
          [{ text: 'Harika', style: 'default' }]
        );
      }
    } catch {
      triggerHaptic('error');
      Alert.alert('Bağlantı Hatası', 'Sızıntı kontrol servisine ulaşılamadı. İnternet bağlantınızı kontrol edin.');
    } finally {
      setIsCheckingBreach(false);
    }
  }, []);

  // URL'yi Tarayıcıda Açma
  const handleOpenUrl = async (rawUrl: string) => {
    const trimmed = rawUrl.trim();
    if (!trimmed) return;
    const normalized = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    try {
      await Linking.openURL(normalized);
    } catch {
      Alert.alert('Hata', 'Bu bağlantı açılamadı.');
    }
  };

  // Özelleştirilebilir Kriptografik Şifre Üretici
  const createRandomSecretString = (
    length: number = genLength,
    includeNumbers: boolean = genIncludeNumbers,
    includeSymbols: boolean = genIncludeSymbols
  ): string => {
    const lowers = 'abcdefghijklmnopqrstuvwxyz';
    const uppers = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const numbers = '0123456789';
    const symbols = '!@#$%^&*()-_=+[]{}';

    let pool = lowers + uppers;
    const mandatory: string[] = [
      lowers[Math.floor(Math.random() * lowers.length)],
      uppers[Math.floor(Math.random() * uppers.length)],
    ];

    if (includeNumbers) {
      pool += numbers;
      mandatory.push(numbers[Math.floor(Math.random() * numbers.length)]);
    }
    if (includeSymbols) {
      pool += symbols;
      mandatory.push(symbols[Math.floor(Math.random() * symbols.length)]);
    }

    const bytes = new Uint8Array(length);
    if (
      typeof globalThis.crypto !== 'undefined' &&
      typeof globalThis.crypto.getRandomValues === 'function'
    ) {
      globalThis.crypto.getRandomValues(bytes);
    }

    const chars: string[] = [];
    for (let i = 0; i < length; i++) {
      chars.push(pool[bytes[i] % pool.length]);
    }

    // Zorunlu karakter tiplerinin en az 1 kez bulunmasını garanti et
    for (let m = 0; m < mandatory.length && m < chars.length; m++) {
      chars[m] = mandatory[m];
    }

    return chars.join('');
  };

  const generateStrongPassword = (
    customLen: number = genLength,
    customNum: boolean = genIncludeNumbers,
    customSym: boolean = genIncludeSymbols
  ) => {
    setNewPassword(createRandomSecretString(customLen, customNum, customSym));
  };

  const generateMasterPasswordSuggestion = () => {
    const generated = createRandomSecretString(
      genLength,
      genIncludeNumbers,
      genIncludeSymbols
    );
    setPassword(generated);
    setConfirmPassword(generated);
    setVisiblePassword(true);
  };

  const score = password ? Math.max(scorePassword(password), 1) : 0;
  const isStrong = score >= 3;

  const handleOwnerNameChange = (text: string) => {
    setOwnerNameInput(text);
    if (errorMessage) setErrorMessage(null);
    const trimmed = text.trim();
    if (trimmed) {
      const candidate = formatVaultFileName(trimmed);
      setCustomVaultName(candidate);
      if (knownVaults.includes(candidate)) {
        kdbxService.setActiveFileName(candidate);
        setVaultState((prev) => ({ ...prev, fileName: candidate }));
      }
    }
  };

  const goToCreateMode = async () => {
    setErrorMessage(null);
    setPassword('');
    setConfirmPassword('');
    const cleanName = ownerNameInput.trim();
    if (cleanName) {
      setCustomVaultName(formatVaultFileName(cleanName));
      await kdbxService.saveProfile({ ownerName: cleanName });
      setVaultState((prev) => ({ ...prev, ownerName: cleanName }));
    }
    setAuthMode('create');
  };

  const goToUnlockMode = async () => {
    setErrorMessage(null);
    setPassword('');
    const cleanName = ownerNameInput.trim();
    if (cleanName) {
      await kdbxService.saveProfile({ ownerName: cleanName });
    }
    const profile = await kdbxService.loadProfile();
    setKnownVaults(profile.knownVaults);
    setVaultState((prev) => ({
      ...prev,
      ownerName: cleanName || profile.ownerName,
      fileName: profile.activeVaultFile,
    }));
    await refreshBiometricState(profile.activeVaultFile);
    setAuthMode('unlock');
  };

  const handleImportKdbxFile = async () => {
    setErrorMessage(null);
    isSystemDialogOpenRef.current = true;
    try {
      const imported = await kdbxService.importVaultFromDevice();
      if (!imported) return;

      const profile = await kdbxService.loadProfile();
      setKnownVaults(profile.knownVaults);
      setVaultState((prev) => ({
        ...prev,
        fileName: imported.fileName,
        filePath: imported.filePath,
      }));
      await refreshBiometricState(imported.fileName);
      setAuthMode('unlock');
      showToast(`"${imported.fileName}" yüklendi`);
    } catch (err: unknown) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : '.kdbx dosyası yüklenirken hata oluştu.'
      );
    } finally {
      setTimeout(() => {
        isSystemDialogOpenRef.current = false;
      }, 600);
    }
  };

  const handleSelectKnownVault = async (vaultFile: string) => {
    setErrorMessage(null);
    kdbxService.setActiveFileName(vaultFile);
    await kdbxService.saveProfile({ activeVaultFile: vaultFile });
    setVaultState((prev) => ({
      ...prev,
      fileName: vaultFile,
    }));
    await refreshBiometricState(vaultFile);
  };

  // Biyometrik Doğrulama ile Kasayı Aç
  const handleBiometricUnlock = async () => {
    setErrorMessage(null);
    setAuthStatus('deriving');
    isSystemDialogOpenRef.current = true;

    try {
      const entries = await kdbxService.unlockWithBiometrics(
        vaultState.fileName
      );
      const profile = await kdbxService.loadProfile();
      setKnownVaults(profile.knownVaults);
      setAuthStatus('unlocked');
      setVaultState({
        isUnlocked: true,
        filePath: kdbxService.getCurrentFilePath(),
        fileName: kdbxService.getActiveFileName(),
        ownerName: profile.ownerName || ownerNameInput.trim(),
        entries,
      });
      setSelectedEntry(entries[0] ?? null);
    } catch (err: unknown) {
      setAuthStatus('idle');
      setErrorMessage(
        err instanceof Error ? err.message : 'Biyometrik giriş yapılamadı.'
      );
    } finally {
      setTimeout(() => {
        isSystemDialogOpenRef.current = false;
      }, 600);
    }
  };

  // Şifre ile Kasayı Aç (openVault)
  const handleUnlock = async () => {
    if (!password.trim() || authStatus === 'deriving') {
      if (!password.trim()) {
        triggerShake();
        triggerHaptic('error');
        setErrorMessage('Lütfen kasa şifrenizi girin.');
      }
      return;
    }

    Keyboard.dismiss();
    setErrorMessage(null);
    setAuthStatus('deriving');
    setDerivingProgress('Kasa dosyası okunuyor...');

    try {
      const cleanOwner = ownerNameInput.trim();
      if (cleanOwner) {
        await kdbxService.saveProfile({ ownerName: cleanOwner });
      }

      const entries = await kdbxService.openVault(
        password,
        vaultState.fileName,
        (status) => setDerivingProgress(status)
      );

      if (biometricSupported && saveBiometricOnAuth) {
        await kdbxService.saveBiometricKeyDirect(
          kdbxService.getActiveFileName(),
          password
        );
        setBiometricEnabledForActive(true);
      }

      const profile = await kdbxService.loadProfile();
      setKnownVaults(profile.knownVaults);
      setAuthStatus('unlocked');
      setDerivingProgress(null);
      setVaultState({
        isUnlocked: true,
        filePath: kdbxService.getCurrentFilePath(),
        fileName: kdbxService.getActiveFileName(),
        ownerName: profile.ownerName || cleanOwner,
        entries,
      });
      setSelectedEntry(entries[0] ?? null);
    } catch (err: unknown) {
      triggerShake();
      triggerHaptic('error');
      setAuthStatus('idle');
      setDerivingProgress(null);
      setErrorMessage(
        err instanceof Error ? err.message : 'Kasa kilidi açılamadı.'
      );
    }
  };

  // Yeni Kasa Oluştur (createVault)
  const handleCreateNewVault = async () => {
    const cleanOwner = ownerNameInput.trim();
    if (!cleanOwner) {
      setErrorMessage('Lütfen önce adınızı girin.');
      return;
    }
    if (!password.trim()) {
      setErrorMessage('Lütfen kasanız için bir şifre belirleyin.');
      return;
    }
    if (password.length < 4) {
      setErrorMessage('Şifre en az 4 karakter olmalıdır.');
      return;
    }
    if (confirmPassword !== password) {
      setErrorMessage('Şifreler birbiriyle eşleşmiyor.');
      return;
    }

    setErrorMessage(null);
    setAuthStatus('deriving');

    try {
      const targetFile = formatVaultFileName(
        customVaultName.trim() || `${cleanOwner}.kdbx`
      );
      const { path, fileName, entries } = await kdbxService.createVault(
        password,
        targetFile,
        cleanOwner
      );

      if (biometricSupported && saveBiometricOnAuth) {
        await kdbxService.saveBiometricKeyDirect(fileName, password);
        setBiometricEnabledForActive(true);
      }

      const profile = await kdbxService.loadProfile();
      setKnownVaults(profile.knownVaults);
      setAuthStatus('unlocked');
      setConfirmPassword('');
      setVaultState({
        isUnlocked: true,
        filePath: path,
        fileName,
        ownerName: cleanOwner,
        entries,
      });
      setSelectedEntry(null);
      showToast(`"${fileName}" oluşturuldu`);
    } catch (err: unknown) {
      setAuthStatus('idle');
      setErrorMessage(
        err instanceof Error ? err.message : 'Yeni kasa oluşturulamadı.'
      );
    }
  };

  // Yeni Kayıt Modalını Aç (Ekleme Modu)
  const openAddEntryModal = () => {
    setEditingEntryId(null);
    setNewTitle('');
    setNewUsername(vaultState.ownerName || '');
    setNewPassword(
      createRandomSecretString(genLength, genIncludeNumbers, genIncludeSymbols)
    );
    setNewUrl('');
    setNewNotes('');
    setNewCategory('logins');
    setAddModalOpen(true);
  };

  // Kayıt Düzenleme Modalını Aç (Düzenleme Modu)
  const openEditEntryModal = (entry: VaultEntry) => {
    setDetailModalOpen(false);
    setEditingEntryId(entry.id);
    setNewTitle(entry.title);
    setNewUsername(entry.username);
    setNewPassword(entry.password);
    setNewUrl(entry.url || '');
    setNewNotes(entry.notes || '');
    setNewCategory(entry.category || 'logins');
    setAddModalOpen(true);
  };

  // Kayıt Ekle veya Güncelle (addEntry / updateEntry) - Sıfır Gecikmeli Arayüz
  const handleSaveEntry = async () => {
    const cleanTitle = newTitle.trim();
    const cleanPass = newPassword.trim();
    if (!cleanTitle || !cleanPass) {
      Alert.alert('Eksik Alan', 'Lütfen Başlık ve Şifre alanlarını doldurun.');
      return;
    }

    const payload = {
      title: cleanTitle,
      username: newUsername.trim(),
      password: newPassword,
      url: newUrl.trim() || undefined,
      notes: newNotes.trim() || undefined,
      category: newCategory,
      monogram: deriveMonogram(cleanTitle),
    };

    const targetEditId = editingEntryId;

    // Modalı ANINDA kapatarak kullanıcıyı bekletme hissini 0'a indiriyoruz
    setAddModalOpen(false);
    setEditingEntryId(null);
    setNewTitle('');
    setNewUsername('');
    setNewPassword('');
    setNewUrl('');
    setNewNotes('');

    if (targetEditId) {
      const optimisticEntry: VaultEntry = {
        ...payload,
        id: targetEditId,
        updatedAt: new Date(),
      };
      setVaultState((prev) => ({
        ...prev,
        entries: prev.entries.map((item) =>
          item.id === targetEditId ? optimisticEntry : item
        ),
      }));
      setSelectedEntry(optimisticEntry);
      showToast('Kayıt güncellendi');

      try {
        await kdbxService.updateEntry(targetEditId, payload);
      } catch {
        showToast('Hata: Değişiklik diske yazılamadı');
      }
    } else {
      showToast('Kayıt kaydediliyor...');
      try {
        const created = await kdbxService.addEntry(payload);
        setVaultState((prev) => ({
          ...prev,
          entries: [created, ...prev.entries],
        }));
        setSelectedEntry(created);
        showToast('Kayıt eklendi');
      } catch (err: unknown) {
        Alert.alert(
          'Hata',
          err instanceof Error ? err.message : 'Kayıt kaydedilemedi.'
        );
      }
    }
  };

  // Kayıt Sil (deleteEntry) - Sıfır Gecikmeli Arayüz
  const handleDeleteEntry = (entry: VaultEntry) => {
    Alert.alert(
      'Kaydı Sil',
      `"${entry.title}" kaydını silmek istediğinize emin misiniz?`,
      [
        { text: 'İptal', style: 'cancel' },
        {
          text: 'Sil',
          style: 'destructive',
          onPress: async () => {
            setDetailModalOpen(false);
            setVaultState((prev) => ({
              ...prev,
              entries: prev.entries.filter((e) => e.id !== entry.id),
            }));
            showToast(`"${entry.title}" silindi`);

            try {
              await kdbxService.deleteEntry(entry.id);
            } catch (err: unknown) {
              Alert.alert(
                'Hata',
                err instanceof Error ? err.message : 'Kayıt silinemedi.'
              );
            }
          },
        },
      ]
    );
  };

  // Kasa Ana Şifresini Değiştir (changeMasterPassword)
  const handleChangeMasterPassword = async () => {
    if (!currentMasterPwInput || !newMasterPwInput) {
      Alert.alert('Eksik Alan', 'Lütfen mevcut ve yeni şifrenizi girin.');
      return;
    }
    if (newMasterPwInput.length < 4) {
      Alert.alert('Hata', 'Yeni ana şifre en az 4 karakter olmalıdır.');
      return;
    }
    if (newMasterPwInput !== confirmNewMasterPwInput) {
      Alert.alert('Hata', 'Yeni şifreler birbiriyle eşleşmiyor.');
      return;
    }

    try {
      await kdbxService.changeMasterPassword(
        currentMasterPwInput,
        newMasterPwInput
      );
      setCurrentMasterPwInput('');
      setNewMasterPwInput('');
      setConfirmNewMasterPwInput('');
      setChangePwSectionOpen(false);
      showToast('Kasa ana şifresi değiştirildi');
    } catch (err: unknown) {
      Alert.alert(
        'Hata',
        err instanceof Error ? err.message : 'Ana şifre değiştirilemedi.'
      );
    }
  };

  // Kasa Dosyasını Cihazdan Sil (deleteVaultFile)
  const handleDeleteVaultFile = (vaultFile: string) => {
    Alert.alert(
      'Kasa Dosyasını Sil',
      `"${vaultFile}" dosyasını ve içindeki tüm kayıtları cihazdan kalıcı olarak silmek istediğinize emin misiniz?`,
      [
        { text: 'İptal', style: 'cancel' },
        {
          text: 'Kalıcı Olarak Sil',
          style: 'destructive',
          onPress: async () => {
            const deletingCurrent = vaultFile === vaultState.fileName;
            const updatedProfile = await kdbxService.deleteVaultFile(vaultFile);
            setKnownVaults(updatedProfile.knownVaults);
            if (deletingCurrent) {
              setSettingsModalOpen(false);
              handleLock(true);
              setVaultState((prev) => ({
                ...prev,
                fileName: updatedProfile.activeVaultFile,
              }));
              await refreshBiometricState(updatedProfile.activeVaultFile);
            }
            showToast(`"${vaultFile}" cihazdan silindi`);
          },
        },
      ]
    );
  };

  // Google Drive Senkronizasyon İşlemi
  const handleSyncWithGoogleDrive = async () => {
    if (!gdriveState.isConnected) {
      setShowTokenInput(true);
      return;
    }

    try {
      setGdriveState((s) => ({ ...s, isSyncing: true, error: null }));
      triggerHaptic('light');

      // 1. Yerel kasanın güncel halini al
      const localBuf = await kdbxService.getCurrentVaultBuffer();

      // 2. Google Drive'da aynı isimde dosya var mı ara
      const remoteFile = await googleDriveSync.findFileInDrive(vaultState.fileName);

      if (remoteFile) {
        // Uzaktaki dosyayı indir
        const remoteBuf = await googleDriveSync.downloadFileFromDrive(remoteFile.id);

        // İki kasayı akıllıca birleştir (merge)
        const mergedEntries = await kdbxService.mergeRemoteVaultBuffer(remoteBuf);
        setVaultState((prev) => ({ ...prev, entries: mergedEntries }));

        // Birleşmiş yeni halini Drive'a geri yükle
        const finalBuf = await kdbxService.getCurrentVaultBuffer();
        await googleDriveSync.uploadFileToDrive(vaultState.fileName, finalBuf);

        showToast('Google Drive ile başarıyla senkronize edildi');
      } else {
        // Drive'da henüz dosya yoksa sıfırdan yükle
        await googleDriveSync.uploadFileToDrive(vaultState.fileName, localBuf);
        showToast('Kasa Google Drive üzerine yedeklendi');
      }

      const updatedState = await googleDriveSync.loadState();
      setGdriveState(updatedState);
      triggerHaptic('success');
    } catch (err: unknown) {
      triggerHaptic('error');
      const msg = err instanceof Error ? err.message : 'Eşitleme başarısız oldu.';
      setGdriveState((s) => ({ ...s, isSyncing: false, error: msg }));
      Alert.alert('Eşitleme Hatası', msg);
    }
  };

  // Google Giriş / Token Kaydetme
  const handleSaveGoogleToken = async () => {
    if (!googleTokenInput.trim()) return;
    await googleDriveSync.setAuthToken(googleTokenInput.trim());
    setShowTokenInput(false);
    setGoogleTokenInput('');
    const updated = await googleDriveSync.loadState();
    setGdriveState(updated);
    showToast('Google hesabı bağlandı');
    triggerHaptic('success');
  };

  // Google Bağlantısını Kes
  const handleDisconnectGoogleDrive = async () => {
    await googleDriveSync.disconnect();
    const updated = await googleDriveSync.loadState();
    setGdriveState(updated);
    showToast('Google Drive bağlantısı kesildi');
    triggerHaptic('light');
  };

  // QR Kod ile Paylaş / Eşle
  const handleOpenQrShare = async () => {
    try {
      triggerHaptic('light');
      const buf = await kdbxService.getCurrentVaultBuffer();
      const { qrString, pin } = qrSync.createSyncPayload(
        vaultState.fileName,
        vaultState.entries.length,
        buf
      );
      setQrPayloadString(qrString);
      setQrPairingPin(pin);
      setQrModalOpen(true);
    } catch (err: unknown) {
      Alert.alert('Hata', 'QR senkronizasyon paketi oluşturulamadı.');
    }
  };

  // QR Kod Tarama Ekranını Güvenle Kapat
  const handleCloseScanner = useCallback(() => {
    setScannerModalOpen(false);
    isScanningRef.current = false;
    setTimeout(() => {
      isSystemDialogOpenRef.current = false;
    }, 1000);
  }, []);

  // QR Kod Tarama Ekranını Aç
  const handleOpenQrScanner = async () => {
    triggerHaptic('light');
    isSystemDialogOpenRef.current = true;
    isScanningRef.current = false;
    try {
      if (!cameraPermission?.granted) {
        const res = await requestCameraPermission();
        if (!res.granted) {
          isSystemDialogOpenRef.current = false;
          Alert.alert('Kamera İzni', 'QR kod taramak için kamera izni gerekiyor.');
          return;
        }
      }
      setScannerModalOpen(true);
    } catch {
      isSystemDialogOpenRef.current = false;
    }
  };

  // Kamera QR Okuduğunda Çalışan Fonksiyon
  const handleBarcodeScanned = async ({ data }: { data: string }) => {
    if (isScanningRef.current) return;
    isScanningRef.current = true;
    setScannerModalOpen(false);

    // Activity / Modal geçişinde otomatik arka plan kilidinin tetiklenmesini engelle
    setTimeout(() => {
      isSystemDialogOpenRef.current = false;
      isScanningRef.current = false;
    }, 2500);

    // 1. Önce Keyra Web PC eşleşmesi mi kontrol et (WhatsApp Web Tarzı)
    const webPayload = webConnectService.parseWebPairingQr(data);
    if (webPayload) {
      triggerHaptic('medium');
      try {
        const entriesToSend =
          vaultState.entries && vaultState.entries.length > 0
            ? vaultState.entries
            : kdbxService.getLoadedEntries();

        let rawKdbxB64: string | undefined = undefined;
        try {
          const buf = await kdbxService.getCurrentVaultBuffer();
          rawKdbxB64 = Buffer.from(buf).toString('base64');
        } catch {
          // İsteğe bağlı
        }

        await webConnectService.sendVaultToWeb(
          webPayload.sessionId,
          webPayload.keyHex,
          vaultState.fileName,
          entriesToSend,
          rawKdbxB64
        );
        triggerHaptic('success');
        showToast('Bilgisayara bağlandı! Şifreleriniz tarayıcıda açıldı.');
      } catch (err: unknown) {
        console.error('sendVaultToWeb error:', err);
        triggerHaptic('error');
        Alert.alert(
          'Bağlantı Hatası',
          'Bilgisayara veri aktarılamadı. Lütfen internet bağlantınızı kontrol edin.'
        );
      }
      return;
    }

    // 2. Normal cihazdan cihaza QR eşleme mi?
    const payload = qrSync.parseQrPayload(data);
    if (!payload) {
      triggerHaptic('error');
      Alert.alert('Geçersiz QR', 'Bu QR kod geçerli bir Keyra senkronizasyon verisi içermiyor.');
      return;
    }

    triggerHaptic('medium');

    if (payload.dataBase64) {
      try {
        const remoteBuffer = Buffer.from(payload.dataBase64, 'base64');
        const exactAb = remoteBuffer.buffer.slice(
          remoteBuffer.byteOffset,
          remoteBuffer.byteOffset + remoteBuffer.byteLength
        );
        const mergedEntries = await kdbxService.mergeRemoteVaultBuffer(exactAb);
        setVaultState((prev) => ({ ...prev, entries: mergedEntries }));
        triggerHaptic('success');
        showToast(`"${payload.vaultFileName}" kasası başarıyla eşitlendi!`);
      } catch {
        triggerHaptic('error');
        Alert.alert(
          'Eşitleme Hatası',
          'Taranan kasa şifresi mevcut kasa şifrenizle eşleşmiyor veya veri bozulmuş.'
        );
      }
    } else {
      Alert.alert(
        'Cihaz Eşlendi',
        `PIN: ${payload.pin}\nCihaz ID: ${payload.deviceId}\nKasa: ${payload.vaultFileName} (${payload.entriesCount} kayıt)\nEşitleme bağlantısı kuruldu.`
      );
    }
  };

  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    return vaultState.entries.filter((entry) => {
      if (filter !== 'all' && entry.category !== filter) return false;
      if (!q) return true;
      return [entry.title, entry.username, entry.url ?? ''].some((field) =>
        field.toLowerCase().includes(q)
      );
    });
  }, [vaultState.entries, query, filter]);

  return (
    <View style={styles.safeArea}>
      <StatusBar style="light" />
      <KeyboardAvoidingView
        style={styles.root}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {toastMessage && (
          <View style={styles.toastBanner}>
            <Ionicons name="checkmark-circle" size={16} color={COLORS.emerald} style={{ marginRight: 6 }} />
            <Text style={styles.toastText}>{toastMessage}</Text>
          </View>
        )}

        {!vaultState.isUnlocked ? (
          <ScrollView
            contentContainerStyle={styles.lockScrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {/* =====================================================
               MOD 1: KASAYA GİR (UNLOCK - GÜNLÜK KULLANICI DENEYİMİ)
               ===================================================== */}
            {authMode === 'unlock' && (
              <View style={styles.lockForm}>
                <Animated.View
                  style={[
                    styles.lockHero,
                    {
                      opacity: heroFadeAnim,
                      transform: [{ scale: heroScaleAnim }],
                    },
                  ]}
                >
                  <View style={styles.logoImageWrap}>
                    <Image
                      source={require('./assets/keyra-logo.png')}
                      style={styles.logoImage}
                      resizeMode="cover"
                    />
                  </View>
                  <View style={styles.lockBrandWrap}>
                    <Text style={styles.lockBrandTitle}>Keyra</Text>
                    <Animated.View
                      style={[
                        styles.activeVaultPill,
                        { transform: [{ scale: pulseAnim }] },
                      ]}
                    >
                      <Ionicons name="lock-closed" size={12} color={COLORS.primary} style={{ marginRight: 5 }} />
                      <Text style={styles.activeVaultPillText} numberOfLines={1}>
                        {vaultState.fileName}
                      </Text>
                      <View style={styles.verifiedDot} />
                    </Animated.View>
                  </View>
                </Animated.View>

                {/* Birden fazla kasa varsa minimalist yatay seçici */}
                {knownVaults.length > 1 && (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.vaultChipsScroll}
                  >
                    {knownVaults.map((vaultFile) => {
                      const active = vaultState.fileName === vaultFile;
                      return (
                        <TouchableOpacity
                          key={vaultFile}
                          onPress={() => handleSelectKnownVault(vaultFile)}
                          style={[
                            styles.vaultChip,
                            active && styles.vaultChipActive,
                          ]}
                        >
                          <Text
                            style={[
                              styles.vaultChipText,
                              active && styles.vaultChipTextActive,
                            ]}
                          >
                            {vaultFile}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                )}

                {/* Şifre Giriş Kartı */}
                <Animated.View
                  style={[
                    styles.passwordCard,
                    { transform: [{ translateX: shakeAnim }] },
                  ]}
                >
                  <View style={[styles.passwordBox, passwordFocused && styles.passwordBoxFocused]}>
                    <Ionicons
                      name="key-outline"
                      size={18}
                      color={passwordFocused ? COLORS.foreground : COLORS.subtleText}
                      style={{ marginRight: 10 }}
                    />
                    <TextInput
                      style={styles.passwordInput}
                      value={password}
                      onChangeText={(t) => {
                        setPassword(t);
                        if (errorMessage) setErrorMessage(null);
                      }}
                      onFocus={() => setPasswordFocused(true)}
                      onBlur={() => setPasswordFocused(false)}
                      secureTextEntry={!visiblePassword}
                      placeholder="Kasa Ana Şifreniz"
                      placeholderTextColor={COLORS.subtleText}
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                    <TouchableOpacity
                      onPress={() => setVisiblePassword((v) => !v)}
                      style={styles.eyeButton}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Ionicons
                        name={visiblePassword ? 'eye-off-outline' : 'eye-outline'}
                        size={18}
                        color={COLORS.mutedForeground}
                      />
                    </TouchableOpacity>
                  </View>

                  {biometricSupported && !biometricEnabledForActive && (
                    <TouchableOpacity
                      activeOpacity={0.8}
                      onPress={() => setSaveBiometricOnAuth((v) => !v)}
                      style={styles.checkboxRow}
                    >
                      <View
                        style={[
                          styles.checkboxBox,
                          saveBiometricOnAuth && styles.checkboxBoxChecked,
                        ]}
                      >
                        {saveBiometricOnAuth && (
                          <Ionicons name="checkmark" size={14} color="#FFFFFF" />
                        )}
                      </View>
                      <Text style={styles.checkboxLabel}>
                        Sonraki girişler için Biyometrik Kilidi kaydet
                      </Text>
                    </TouchableOpacity>
                  )}

                  {errorMessage && (
                    <View style={styles.errorBanner}>
                      <Ionicons name="alert-circle-outline" size={15} color={COLORS.dangerRed} style={{ marginRight: 6 }} />
                      <Text style={styles.errorBannerText}>{errorMessage}</Text>
                    </View>
                  )}

                  <TouchableOpacity
                    activeOpacity={0.85}
                    disabled={!password.trim() || authStatus === 'deriving'}
                    onPress={handleUnlock}
                    style={[
                      styles.unlockButton,
                      (!password.trim() || authStatus === 'deriving') &&
                        styles.unlockButtonDisabled,
                    ]}
                  >
                    {authStatus === 'deriving' ? (
                      <View style={styles.derivingRow}>
                        <ActivityIndicator
                          size="small"
                          color={COLORS.primaryForeground}
                        />
                        <Text style={styles.unlockButtonText}>
                          {derivingProgress || 'Açılıyor...'}
                        </Text>
                      </View>
                    ) : (
                      <Text style={styles.unlockButtonText}>Kasayı Aç</Text>
                    )}
                  </TouchableOpacity>

                  {biometricSupported && biometricEnabledForActive && (
                    <TouchableOpacity
                      activeOpacity={0.82}
                      onPress={handleBiometricUnlock}
                      style={styles.biometricButton}
                    >
                      <Ionicons
                        name="finger-print-outline"
                        size={20}
                        color={COLORS.foreground}
                        style={{ marginRight: 8 }}
                      />
                      <Text style={styles.biometricButtonText}>
                        Biyometrik Kilit ile Hızlı Aç
                      </Text>
                    </TouchableOpacity>
                  )}
                </Animated.View>

                {/* Alt Minimalist Bağlantılar */}
                <View style={styles.lockFooterLinks}>
                  <TouchableOpacity onPress={goToCreateMode} style={styles.footerLinkBtn}>
                    <Ionicons name="add-circle-outline" size={15} color={COLORS.mutedForeground} style={{ marginRight: 5 }} />
                    <Text style={styles.footerLinkText}>Yeni Kasa</Text>
                  </TouchableOpacity>

                  <View style={styles.footerDot} />

                  <TouchableOpacity onPress={handleImportKdbxFile} style={styles.footerLinkBtn}>
                    <Ionicons name="folder-open-outline" size={15} color={COLORS.mutedForeground} style={{ marginRight: 5 }} />
                    <Text style={styles.footerLinkText}>.kdbx Aç</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {/* =====================================================
               MOD 2: YENİ KASA OLUŞTUR
               ===================================================== */}
            {authMode === 'create' && (
              <View style={styles.lockForm}>
                <View style={styles.createTopNav}>
                  <TouchableOpacity
                    onPress={() => {
                      triggerHaptic('light');
                      if (knownVaults.length > 0) goToUnlockMode();
                      else setAuthMode('welcome');
                    }}
                    style={styles.createBackBtn}
                  >
                    <Ionicons name="chevron-back" size={20} color={COLORS.mutedForeground} />
                    <Text style={styles.createBackText}>Geri</Text>
                  </TouchableOpacity>
                  <Text style={styles.createTitle}>Yeni Kasa</Text>
                  <View style={{ width: 50 }} />
                </View>

                <View style={styles.groupedFormCard}>
                  <View style={styles.formRow}>
                    <Text style={styles.formRowLabel}>ADINIZ</Text>
                    <TextInput
                      style={styles.formRowInput}
                      value={ownerNameInput}
                      onChangeText={handleOwnerNameChange}
                      placeholder="Örn: Kuzey"
                      placeholderTextColor={COLORS.subtleText}
                      autoCapitalize="words"
                      autoCorrect={false}
                    />
                  </View>

                  <View style={styles.formDivider} />

                  <View style={styles.formRow}>
                    <Text style={styles.formRowLabel}>KASA DOSYA ADI</Text>
                    <TextInput
                      style={styles.formRowInput}
                      value={customVaultName}
                      onChangeText={(t) => {
                        setCustomVaultName(t);
                        if (errorMessage) setErrorMessage(null);
                      }}
                      placeholder="Örn: Kuzey.kdbx"
                      placeholderTextColor={COLORS.subtleText}
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                  </View>

                  <View style={styles.formDivider} />

                  <View style={styles.formRow}>
                    <View style={styles.fieldLabelRow}>
                      <Text style={styles.formRowLabel}>ANA ŞİFRE</Text>
                      <TouchableOpacity onPress={generateMasterPasswordSuggestion}>
                        <Text style={styles.regenerateLink}>Şifre Öner</Text>
                      </TouchableOpacity>
                    </View>
                    <View style={styles.inputInnerRow}>
                      <TextInput
                        style={styles.formRowInputInner}
                        value={password}
                        onChangeText={(t) => {
                          setPassword(t);
                          if (errorMessage) setErrorMessage(null);
                        }}
                        secureTextEntry={!visiblePassword}
                        placeholder="Kasa şifrenizi belirleyin"
                        placeholderTextColor={COLORS.subtleText}
                        autoCapitalize="none"
                        autoCorrect={false}
                      />
                      <TouchableOpacity
                        onPress={() => setVisiblePassword((v) => !v)}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <Ionicons
                          name={visiblePassword ? 'eye-off-outline' : 'eye-outline'}
                          size={18}
                          color={COLORS.mutedForeground}
                        />
                      </TouchableOpacity>
                    </View>

                    {password.length > 0 && (
                      <View style={styles.strengthRow}>
                        <View style={styles.strengthBars}>
                          {[1, 2, 3, 4].map((segment) => {
                            const active = segment <= score;
                            return (
                              <View
                                key={segment}
                                style={[
                                  styles.strengthSegment,
                                  active
                                    ? isStrong
                                      ? styles.strengthPrimary
                                      : styles.strengthDestructive
                                    : styles.strengthInactive,
                                ]}
                              />
                            );
                          })}
                        </View>
                        <Text style={styles.strengthLabel}>
                          {STRENGTH_LABELS[score]}
                        </Text>
                      </View>
                    )}
                  </View>

                  <View style={styles.formDivider} />

                  <View style={styles.formRow}>
                    <Text style={styles.formRowLabel}>ŞİFRE TEKRARI</Text>
                    <TextInput
                      style={styles.formRowInput}
                      value={confirmPassword}
                      onChangeText={(t) => {
                        setConfirmPassword(t);
                        if (errorMessage) setErrorMessage(null);
                      }}
                      secureTextEntry={!visiblePassword}
                      placeholder="Şifrenizi onaylayın"
                      placeholderTextColor={COLORS.subtleText}
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                  </View>
                </View>

                {biometricSupported && (
                  <TouchableOpacity
                    activeOpacity={0.8}
                    onPress={() => setSaveBiometricOnAuth((v) => !v)}
                    style={styles.checkboxRow}
                  >
                    <View
                      style={[
                        styles.checkboxBox,
                        saveBiometricOnAuth && styles.checkboxBoxChecked,
                      ]}
                    >
                      {saveBiometricOnAuth && (
                        <Ionicons name="checkmark" size={14} color="#FFFFFF" />
                      )}
                    </View>
                    <Text style={styles.checkboxLabel}>
                      Parmak İzi / Yüz Tanıma ile girişi etkinleştir
                    </Text>
                  </TouchableOpacity>
                )}

                {errorMessage && (
                  <View style={styles.errorBanner}>
                    <Ionicons name="alert-circle-outline" size={15} color={COLORS.dangerRed} style={{ marginRight: 6 }} />
                    <Text style={styles.errorBannerText}>{errorMessage}</Text>
                  </View>
                )}

                <TouchableOpacity
                  activeOpacity={0.85}
                  disabled={authStatus === 'deriving'}
                  onPress={handleCreateNewVault}
                  style={[
                    styles.unlockButton,
                    authStatus === 'deriving' && styles.unlockButtonDisabled,
                  ]}
                >
                  {authStatus === 'deriving' ? (
                    <ActivityIndicator
                      size="small"
                      color={COLORS.primaryForeground}
                    />
                  ) : (
                    <Text style={styles.unlockButtonText}>
                      Kasayı Oluştur ve Başla
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
            )}

            {/* =====================================================
               MOD 3: İLK KURULUM (WELCOME)
               ===================================================== */}
            {authMode === 'welcome' && (
              <View style={styles.lockForm}>
                <View style={styles.lockHero}>
                  <View style={styles.logoImageWrap}>
                    <Image
                      source={require('./assets/keyra-logo.png')}
                      style={styles.logoImage}
                      resizeMode="cover"
                    />
                  </View>
                  <View style={styles.lockBrandWrap}>
                    <Text style={styles.lockBrandTitle}>Keyra</Text>
                    <Text style={styles.lockBrandSubtitle}>
                      KeePass • %100 Çevrimdışı & Güvenli Kasa
                    </Text>
                  </View>
                </View>

                <View style={styles.welcomeIntroCard}>
                  <View style={styles.introFeatureRow}>
                    <Ionicons name="shield-checkmark" size={18} color={COLORS.emerald} style={{ marginRight: 10 }} />
                    <Text style={styles.introFeatureText}>Verileriniz yalnızca bu cihazda kalır, buluta sızmaz.</Text>
                  </View>
                  <View style={styles.introFeatureRow}>
                    <Ionicons name="hardware-chip-outline" size={18} color={COLORS.primary} style={{ marginRight: 10 }} />
                    <Text style={styles.introFeatureText}>Askeri düzeyde AES & Argon2 şifreleme motoru.</Text>
                  </View>
                </View>

                {errorMessage && (
                  <View style={styles.errorBanner}>
                    <Ionicons name="alert-circle-outline" size={15} color={COLORS.dangerRed} style={{ marginRight: 6 }} />
                    <Text style={styles.errorBannerText}>{errorMessage}</Text>
                  </View>
                )}

                <TouchableOpacity
                  activeOpacity={0.85}
                  onPress={goToCreateMode}
                  style={styles.unlockButton}
                >
                  <Text style={styles.unlockButtonText}>
                    Kendime Kasa Oluştur
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  activeOpacity={0.82}
                  onPress={handleImportKdbxFile}
                  style={styles.secondaryButton}
                >
                  <Ionicons name="folder-open-outline" size={16} color={COLORS.foreground} style={{ marginRight: 8 }} />
                  <Text style={styles.secondaryButtonText}>
                    Cihazdan .kdbx Dosyası Aç
                  </Text>
                </TouchableOpacity>
              </View>
            )}
          </ScrollView>
        ) : (
          /* =========================================================
             KASA İÇİ PANEL (DASHBOARD)
             ========================================================= */
          <View style={styles.dashboardContainer}>
            {/* Üst Başlık */}
            <View style={styles.dashHeader}>
              <View style={styles.dashHeaderLeft}>
                <Image
                  source={require('./assets/keyra-logo.png')}
                  style={styles.dashLogoMini}
                  resizeMode="cover"
                />
                <View>
                  <Text style={styles.dashBrandName}>
                    {vaultState.ownerName ? `${vaultState.ownerName} Kasası` : 'Keyra'}
                  </Text>
                  <Text style={styles.vaultFileName} numberOfLines={1}>
                    {vaultState.fileName} • {vaultState.entries.length} Kayıt
                  </Text>
                </View>
              </View>

              <View style={styles.dashHeaderActions}>
                <TouchableOpacity
                  activeOpacity={0.75}
                  onPress={handleOpenQrScanner}
                  style={styles.headerIconButton}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons name="laptop-outline" size={20} color={COLORS.primary} />
                </TouchableOpacity>

                <TouchableOpacity
                  activeOpacity={0.75}
                  onPress={() => {
                    triggerHaptic('light');
                    setChangePwSectionOpen(false);
                    setSettingsModalOpen(true);
                  }}
                  style={styles.headerIconButton}
                >
                  <Ionicons name="settings-outline" size={19} color={COLORS.mutedForeground} />
                </TouchableOpacity>

                <TouchableOpacity
                  activeOpacity={0.75}
                  onPress={() => {
                    triggerHaptic('medium');
                    handleLock(false);
                  }}
                  style={styles.headerLockIconButton}
                >
                  <Ionicons name="lock-closed" size={16} color={COLORS.dangerRed} />
                </TouchableOpacity>
              </View>
            </View>

            {/* Arama Çubuğu */}
            <View style={styles.searchSection}>
              <View style={styles.searchBar}>
                <Ionicons
                  name="search"
                  size={16}
                  color={COLORS.subtleText}
                  style={{ marginRight: 8 }}
                />
                <TextInput
                  style={styles.searchBarInput}
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Kayıtlarda veya hesaplarda ara..."
                  placeholderTextColor={COLORS.subtleText}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                {query.length > 0 && (
                  <TouchableOpacity
                    onPress={() => {
                      triggerHaptic('light');
                      setQuery('');
                    }}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Ionicons name="close-circle" size={17} color={COLORS.subtleText} />
                  </TouchableOpacity>
                )}
              </View>
            </View>

            {/* Kategori Filtreleri */}
            <View style={styles.filtersWrapper}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.filtersScroll}
              >
                {FILTERS.map((item) => {
                  const active = filter === item.id;
                  const iconName =
                    item.id === 'all'
                      ? 'grid-outline'
                      : item.id === 'logins'
                      ? 'key-outline'
                      : item.id === 'servers'
                      ? 'server-outline'
                      : item.id === 'tokens'
                      ? 'shield-checkmark-outline'
                      : 'document-text-outline';

                  return (
                    <TouchableOpacity
                      key={item.id}
                      activeOpacity={0.75}
                      onPress={() => {
                        triggerHaptic('light');
                        setFilter(item.id);
                      }}
                      style={[
                        styles.filterPill,
                        active
                          ? styles.filterPillActive
                          : styles.filterPillInactive,
                      ]}
                    >
                      <Ionicons
                        name={iconName as any}
                        size={13}
                        color={active ? '#FFFFFF' : COLORS.mutedForeground}
                        style={{ marginRight: 6 }}
                      />
                      <Text
                        style={[
                          styles.filterPillText,
                          active
                            ? styles.filterPillTextActive
                            : styles.filterPillTextInactive,
                        ]}
                      >
                        {item.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>

            {/* Kayıt Listesi */}
            <View style={styles.entriesSection}>
              <FlatList
                data={filteredEntries}
                keyExtractor={(item) => item.id}
                showsVerticalScrollIndicator={false}
                contentContainerStyle={styles.entriesListContent}
                initialNumToRender={10}
                maxToRenderPerBatch={8}
                windowSize={5}
                removeClippedSubviews={Platform.OS === 'android'}
                renderItem={({ item }) => (
                  <EntryCardItem
                    entry={item}
                    onCopyText={handleCopyText}
                    onOpenDetail={handleOpenDetail}
                  />
                )}
                ListEmptyComponent={
                  <View style={styles.emptySearchBox}>
                    <Ionicons
                      name={query ? "search-outline" : "shield-checkmark-outline"}
                      size={42}
                      color={COLORS.subtleText}
                      style={{ marginBottom: 12, opacity: 0.7 }}
                    />
                    <Text style={styles.emptySearchTitle}>
                      {query
                        ? `"${query}" bulunamadı`
                        : 'Kasanızda henüz kayıt yok'}
                    </Text>
                    <Text style={styles.emptySearchSubtitle}>
                      {query
                        ? 'Farklı bir arama terimi deneyin.'
                        : 'İlk şifrenizi ekleyin ve çevrimdışı güvende tutun.'}
                    </Text>
                    {!query && (
                      <TouchableOpacity
                        activeOpacity={0.85}
                        onPress={() => {
                          triggerHaptic('medium');
                          openAddEntryModal();
                        }}
                        style={styles.emptyAddBtn}
                      >
                        <Ionicons name="add" size={17} color="#FFFFFF" style={{ marginRight: 4 }} />
                        <Text style={styles.emptyAddBtnText}>
                          İlk Kaydı Ekle
                        </Text>
                      </TouchableOpacity>
                    )}
                  </View>
                }
              />
            </View>

            {/* Sağ Alt Yeni Kayıt Ekleme Butonu */}
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={() => {
                triggerHaptic('medium');
                openAddEntryModal();
              }}
              style={styles.fabButton}
            >
              <Ionicons name="add" size={26} color="#FFFFFF" />
            </TouchableOpacity>
          </View>
        )}

        {/* =========================================================
           KAYIT DETAY MODALI (Şifre Gizleme + URL Açma + Düzenleme)
           ========================================================= */}
        <Modal
          visible={detailModalOpen && Boolean(selectedEntry)}
          transparent
          animationType="slide"
          onRequestClose={() => setDetailModalOpen(false)}
        >
          <View style={styles.sheetBackdrop}>
            <View style={styles.sheetCard}>
              <View style={styles.sheetHandle} />

              {selectedEntry && (
                <>
                  <View style={styles.sheetHeader}>
                    <View style={styles.detailTitleRow}>
                      {(() => {
                        const pal = getMonogramStyle(selectedEntry.title);
                        const mono = selectedEntry.monogram || deriveMonogram(selectedEntry.title);
                        return (
                          <View style={[styles.detailMonogramBadge, { backgroundColor: pal.bg, borderColor: pal.border }]}>
                            <Text style={[styles.detailMonogramText, { color: pal.text }]}>{mono}</Text>
                          </View>
                        );
                      })()}
                      <View style={{ flex: 1 }}>
                        <Text style={styles.sheetTitle}>{selectedEntry.title}</Text>
                        <Text style={styles.detailCategoryLabel}>
                          {FILTERS.find((f) => f.id === selectedEntry.category)?.label || 'Giriş'}
                        </Text>
                      </View>
                    </View>
                    <TouchableOpacity
                      onPress={() => {
                        triggerHaptic('light');
                        setDetailModalOpen(false);
                      }}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      style={styles.closeIconButton}
                    >
                      <Ionicons name="close" size={20} color={COLORS.mutedForeground} />
                    </TouchableOpacity>
                  </View>

                  <View style={styles.detailRowBox}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.fieldLabel}>KULLANICI ADI</Text>
                      <Text style={styles.detailValueMono}>
                        {selectedEntry.username || '—'}
                      </Text>
                    </View>
                    {selectedEntry.username ? (
                      <TouchableOpacity
                        onPress={() => {
                          triggerHaptic('success');
                          handleCopyText(
                            selectedEntry.username,
                            'Kullanıcı adı'
                          );
                        }}
                        style={styles.detailCopyPill}
                      >
                        <Ionicons name="copy-outline" size={13} color={COLORS.primary} style={{ marginRight: 4 }} />
                        <Text style={styles.detailCopyPillText}>Kopyala</Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>

                  {/* Şifre Satırı (Varsayılan Gizli + Göster/Gizle + Kopyala + Güç Çubuğu) */}
                  <View style={styles.detailRowBox}>
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginRight: 10 }}>
                        <Text style={styles.fieldLabel}>ŞİFRE</Text>
                        {(() => {
                          const strScore = scorePassword(selectedEntry.password);
                          return (
                            <Text style={{ fontSize: 10, fontWeight: '700', color: STRENGTH_COLORS[strScore] }}>
                              {STRENGTH_LABELS[strScore]}
                            </Text>
                          );
                        })()}
                      </View>
                      <Text style={styles.detailValueMono}>
                        {detailPasswordVisible
                          ? selectedEntry.password
                          : '••••••••••••••••'}
                      </Text>

                      {/* Güç Çubuğu */}
                      {(() => {
                        const strScore = scorePassword(selectedEntry.password);
                        return (
                          <View style={styles.strengthMeterContainer}>
                            {[1, 2, 3, 4].map((seg) => (
                              <View
                                key={seg}
                                style={[
                                  styles.strengthSegment,
                                  {
                                    backgroundColor:
                                      seg <= strScore
                                        ? STRENGTH_COLORS[strScore]
                                        : 'rgba(255,255,255,0.08)',
                                  },
                                ]}
                              />
                            ))}
                          </View>
                        );
                      })()}
                    </View>
                    <View style={styles.inlinePillGroup}>
                      <TouchableOpacity
                        onPress={() => {
                          triggerHaptic('light');
                          setDetailPasswordVisible((v) => !v);
                        }}
                        style={styles.detailCopyPill}
                      >
                        <Ionicons
                          name={detailPasswordVisible ? 'eye-off-outline' : 'eye-outline'}
                          size={13}
                          color={COLORS.primary}
                          style={{ marginRight: 4 }}
                        />
                        <Text style={styles.detailCopyPillText}>
                          {detailPasswordVisible ? 'Gizle' : 'Göster'}
                        </Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        onPress={() => {
                          triggerHaptic('success');
                          handleCopyText(selectedEntry.password, 'Şifre');
                        }}
                        style={styles.detailCopyPill}
                      >
                        <Ionicons name="copy-outline" size={13} color={COLORS.primary} style={{ marginRight: 4 }} />
                        <Text style={styles.detailCopyPillText}>Kopyala</Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        disabled={isCheckingBreach}
                        onPress={() => handleCheckBreach(selectedEntry.password, selectedEntry.title)}
                        style={[styles.detailCopyPill, { borderColor: 'rgba(245, 158, 11, 0.35)', backgroundColor: 'rgba(245, 158, 11, 0.08)' }]}
                      >
                        {isCheckingBreach ? (
                          <ActivityIndicator size="small" color="#F59E0B" />
                        ) : (
                          <>
                            <Ionicons name="shield-outline" size={13} color="#F59E0B" style={{ marginRight: 4 }} />
                            <Text style={[styles.detailCopyPillText, { color: '#F59E0B' }]}>Sızıntı Tara</Text>
                          </>
                        )}
                      </TouchableOpacity>
                    </View>
                  </View>

                  {/* URL Satırı (Tarayıcıda Aç + Kopyala) */}
                  {selectedEntry.url ? (
                    <View style={styles.detailRowBox}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.fieldLabel}>URL</Text>
                        <Text style={styles.detailValueMono} numberOfLines={1}>
                          {selectedEntry.url}
                        </Text>
                      </View>
                      <View style={styles.inlinePillGroup}>
                        <TouchableOpacity
                          onPress={() => {
                            triggerHaptic('light');
                            handleOpenUrl(selectedEntry.url!);
                          }}
                          style={styles.detailCopyPill}
                        >
                          <Feather name="external-link" size={12} color={COLORS.cyanAccent} style={{ marginRight: 4 }} />
                          <Text style={[styles.detailCopyPillText, { color: COLORS.cyanAccent }]}>Aç</Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                          onPress={() => {
                            triggerHaptic('success');
                            handleCopyText(selectedEntry.url!, 'URL');
                          }}
                          style={styles.detailCopyPill}
                        >
                          <Ionicons name="copy-outline" size={13} color={COLORS.primary} style={{ marginRight: 4 }} />
                          <Text style={styles.detailCopyPillText}>Kopyala</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  ) : null}

                  {selectedEntry.notes ? (
                    <View style={styles.detailRowBox}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.fieldLabel}>NOTLAR</Text>
                        <Text style={styles.detailValueMono}>
                          {selectedEntry.notes}
                        </Text>
                      </View>
                    </View>
                  ) : null}

                  <View style={styles.detailRowBox}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.fieldLabel}>SON GÜNCELLEME</Text>
                      <Text style={styles.detailValueMono}>
                        {selectedEntry.updatedAt instanceof Date
                          ? selectedEntry.updatedAt.toLocaleString('tr-TR')
                          : new Date(selectedEntry.updatedAt).toLocaleString(
                              'tr-TR'
                            )}
                      </Text>
                    </View>
                  </View>

                  {/* Düzenle & Sil Aksiyonları */}
                  <View style={styles.detailActionButtons}>
                    <TouchableOpacity
                      activeOpacity={0.85}
                      onPress={() => {
                        triggerHaptic('medium');
                        openEditEntryModal(selectedEntry);
                      }}
                      style={[styles.unlockButton, { flex: 1 }]}
                    >
                      <Feather name="edit-2" size={16} color={COLORS.primaryForeground} style={{ marginRight: 8 }} />
                      <Text style={styles.unlockButtonText}>Kaydı Düzenle</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      activeOpacity={0.85}
                      onPress={() => {
                        triggerHaptic('error');
                        handleDeleteEntry(selectedEntry);
                      }}
                      style={styles.deleteIconButton}
                    >
                      <Feather name="trash-2" size={18} color={COLORS.dangerRed} />
                    </TouchableOpacity>
                  </View>
                </>
              )}
            </View>
          </View>
        </Modal>

        {/* =========================================================
           KAYIT EKLEME / DÜZENLEME & ÖZELLEŞTİRİLEBİLİR ŞİFRE ÜRETİCİ
           ========================================================= */}
        <Modal
          visible={addModalOpen}
          transparent
          animationType="slide"
          onRequestClose={() => {
            setAddModalOpen(false);
            setEditingEntryId(null);
          }}
        >
          <KeyboardAvoidingView
            style={styles.sheetBackdrop}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <View style={styles.sheetCard}>
              <View style={styles.sheetHandle} />

              <View style={styles.sheetHeader}>
                <Text style={styles.sheetTitle}>
                  {editingEntryId ? 'Kaydı Düzenle' : 'Yeni Kayıt Ekle'}
                </Text>
                <TouchableOpacity
                  onPress={() => {
                    triggerHaptic('light');
                    setAddModalOpen(false);
                    setEditingEntryId(null);
                  }}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  style={styles.closeIconButton}
                >
                  <Ionicons name="close" size={20} color={COLORS.mutedForeground} />
                </TouchableOpacity>
              </View>

              <ScrollView
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ gap: 14 }}
              >
                <View style={styles.modalFieldGroup}>
                  <Text style={styles.fieldLabel}>BAŞLIK *</Text>
                  <TextInput
                    style={styles.modalInputBox}
                    placeholder="Örn: GitHub, E-Posta, Banka"
                    placeholderTextColor={COLORS.subtleText}
                    value={newTitle}
                    onChangeText={setNewTitle}
                  />
                </View>

                <View style={styles.modalFieldGroup}>
                  <View style={styles.fieldLabelRow}>
                    <Text style={styles.fieldLabel}>KULLANICI ADI</Text>
                    {vaultState.ownerName ? (
                      <TouchableOpacity
                        onPress={() => {
                          triggerHaptic('light');
                          setNewUsername(vaultState.ownerName);
                        }}
                      >
                        <Text style={styles.regenerateLink}>
                          Adımı Kullan ({vaultState.ownerName})
                        </Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                  <TextInput
                    style={styles.modalInputBox}
                    placeholder="Örn: kuzey@domain.com"
                    placeholderTextColor={COLORS.subtleText}
                    value={newUsername}
                    onChangeText={setNewUsername}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>

                <View style={styles.modalFieldGroup}>
                  <View style={styles.fieldLabelRow}>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <Text style={styles.fieldLabel}>ŞİFRE *</Text>
                      {newPassword ? (
                        <Text
                          style={{
                            marginLeft: 8,
                            fontSize: 10,
                            fontWeight: '700',
                            color: STRENGTH_COLORS[scorePassword(newPassword)],
                          }}
                        >
                          • {STRENGTH_LABELS[scorePassword(newPassword)]}
                        </Text>
                      ) : null}
                    </View>
                    <TouchableOpacity
                      activeOpacity={0.75}
                      onPress={() => {
                        triggerHaptic('light');
                        generateStrongPassword(
                          genLength,
                          genIncludeNumbers,
                          genIncludeSymbols
                        );
                      }}
                      style={{ flexDirection: 'row', alignItems: 'center' }}
                    >
                      <Ionicons name="refresh" size={13} color={COLORS.primary} style={{ marginRight: 4 }} />
                      <Text style={styles.regenerateLink}>Yeni Üret</Text>
                    </TouchableOpacity>
                  </View>
                  <TextInput
                    style={[styles.modalInputBox, { fontFamily: MONO_FONT }]}
                    placeholder="Şifre girin veya üretin"
                    placeholderTextColor={COLORS.subtleText}
                    value={newPassword}
                    onChangeText={setNewPassword}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />

                  {/* Canlı Şifre Gücü Göstergesi */}
                  {newPassword ? (
                    <View style={[styles.strengthMeterContainer, { marginTop: 6 }]}>
                      {[1, 2, 3, 4].map((seg) => (
                        <View
                          key={seg}
                          style={[
                            styles.strengthSegment,
                            {
                              backgroundColor:
                                seg <= scorePassword(newPassword)
                                  ? STRENGTH_COLORS[scorePassword(newPassword)]
                                  : 'rgba(255,255,255,0.08)',
                            },
                          ]}
                        />
                      ))}
                    </View>
                  ) : null}

                  {/* Özelleştirilebilir Şifre Üretici Kontrolleri */}
                  <View style={styles.generatorOptionsRow}>
                    <View style={styles.generatorLengthsGroup}>
                      {GENERATOR_LENGTHS.map((len) => {
                        const active = genLength === len;
                        return (
                          <TouchableOpacity
                            key={len}
                            onPress={() => {
                              triggerHaptic('light');
                              setGenLength(len);
                              generateStrongPassword(
                                len,
                                genIncludeNumbers,
                                genIncludeSymbols
                              );
                            }}
                            style={[
                              styles.genOptionPill,
                              active && styles.genOptionPillActive,
                            ]}
                          >
                            <Text
                              style={[
                                styles.genOptionPillText,
                                active && styles.genOptionPillTextActive,
                              ]}
                            >
                              {len}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>

                    <View style={styles.generatorLengthsGroup}>
                      <TouchableOpacity
                        onPress={() => {
                          triggerHaptic('light');
                          const next = !genIncludeNumbers;
                          setGenIncludeNumbers(next);
                          generateStrongPassword(
                            genLength,
                            next,
                            genIncludeSymbols
                          );
                        }}
                        style={[
                          styles.genOptionPill,
                          genIncludeNumbers && styles.genOptionPillActive,
                        ]}
                      >
                        <Text
                          style={[
                            styles.genOptionPillText,
                            genIncludeNumbers && styles.genOptionPillTextActive,
                          ]}
                        >
                          0-9
                        </Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        onPress={() => {
                          triggerHaptic('light');
                          const next = !genIncludeSymbols;
                          setGenIncludeSymbols(next);
                          generateStrongPassword(
                            genLength,
                            genIncludeNumbers,
                            next
                          );
                        }}
                        style={[
                          styles.genOptionPill,
                          genIncludeSymbols && styles.genOptionPillActive,
                        ]}
                      >
                        <Text
                          style={[
                            styles.genOptionPillText,
                            genIncludeSymbols && styles.genOptionPillTextActive,
                          ]}
                        >
                          !@#
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                </View>

                <View style={styles.modalFieldGroup}>
                  <Text style={styles.fieldLabel}>URL (İSTEĞE BAĞLI)</Text>
                  <TextInput
                    style={styles.modalInputBox}
                    placeholder="https://..."
                    placeholderTextColor={COLORS.subtleText}
                    value={newUrl}
                    onChangeText={setNewUrl}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>

                <View style={styles.modalFieldGroup}>
                  <Text style={styles.fieldLabel}>NOTLAR (İSTEĞE BAĞLI)</Text>
                  <TextInput
                    style={[styles.modalInputBox, { minHeight: 64, textAlignVertical: 'top' }]}
                    placeholder="Ek notlar veya açıklamalar"
                    placeholderTextColor={COLORS.subtleText}
                    value={newNotes}
                    onChangeText={setNewNotes}
                    multiline
                  />
                </View>

                <View style={styles.modalFieldGroup}>
                  <Text style={styles.fieldLabel}>KATEGORİ</Text>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={{ gap: 8, paddingVertical: 4 }}
                  >
                    {(
                      [
                        { cat: 'logins', label: 'Girişler', icon: 'key-outline' },
                        { cat: 'servers', label: 'Sunucular', icon: 'server-outline' },
                        { cat: 'tokens', label: 'Tokenlar', icon: 'shield-checkmark-outline' },
                        { cat: 'notes', label: 'Notlar', icon: 'document-text-outline' },
                      ] as const
                    ).map((item) => {
                      const active = newCategory === item.cat;
                      return (
                        <TouchableOpacity
                          key={item.cat}
                          onPress={() => {
                            triggerHaptic('light');
                            setNewCategory(item.cat);
                          }}
                          style={[
                            styles.filterPill,
                            active
                              ? styles.filterPillActive
                              : styles.filterPillInactive,
                          ]}
                        >
                          <Ionicons
                            name={item.icon as any}
                            size={13}
                            color={active ? '#08090C' : COLORS.mutedForeground}
                            style={{ marginRight: 5 }}
                          />
                          <Text
                            style={[
                              styles.filterPillText,
                              active
                                ? styles.filterPillTextActive
                                : styles.filterPillTextInactive,
                            ]}
                          >
                            {item.label}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                </View>

                <TouchableOpacity
                  activeOpacity={0.85}
                  disabled={isSaving}
                  onPress={() => {
                    triggerHaptic('medium');
                    handleSaveEntry();
                  }}
                  style={styles.unlockButton}
                >
                  <Ionicons name="checkmark-sharp" size={18} color={COLORS.primaryForeground} style={{ marginRight: 6 }} />
                  <Text style={styles.unlockButtonText}>
                    {isSaving
                      ? 'Kaydediliyor…'
                      : editingEntryId
                      ? 'Değişiklikleri Kaydet'
                      : 'Kaydı Kaydet'}
                  </Text>
                </TouchableOpacity>
              </ScrollView>
            </View>
          </KeyboardAvoidingView>
        </Modal>

        {/* =========================================================
           AYARLAR, ANA ŞİFRE DEĞİŞTİRME & KASA DOSYA YÖNETİMİ MODALI
           ========================================================= */}
        <Modal
          visible={settingsModalOpen}
          transparent
          animationType="slide"
          onRequestClose={() => setSettingsModalOpen(false)}
        >
          <KeyboardAvoidingView
            style={styles.sheetBackdrop}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <View style={styles.sheetCard}>
              <View style={styles.sheetHandle} />

              <View style={styles.sheetHeader}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Ionicons name="settings-outline" size={20} color={COLORS.primary} style={{ marginRight: 8 }} />
                  <Text style={styles.sheetTitle}>Ayarlar</Text>
                </View>
                <TouchableOpacity
                  onPress={() => {
                    triggerHaptic('light');
                    setSettingsModalOpen(false);
                  }}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  style={styles.closeIconButton}
                >
                  <Ionicons name="close" size={20} color={COLORS.mutedForeground} />
                </TouchableOpacity>
              </View>

              <ScrollView
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ gap: 18, paddingBottom: 24 }}
              >
                {/* GRUP 1: PROFİL */}
                <View style={styles.settingsSection}>
                  <Text style={styles.settingsSectionHeader}>PROFİL</Text>
                  <View style={styles.settingsGroupCard}>
                    <View style={styles.settingsRow}>
                      <View style={[styles.settingsIconBox, { backgroundColor: 'rgba(255, 255, 255, 0.08)' }]}>
                        <Ionicons name="person" size={15} color="#FFFFFF" />
                      </View>
                      <View style={{ flex: 1, marginRight: 8 }}>
                        <Text style={styles.settingRowTitle}>Kasa Sahibi</Text>
                        <TextInput
                          style={styles.settingsInlineInput}
                          value={ownerNameInput}
                          onChangeText={setOwnerNameInput}
                          placeholder="Adınızı belirleyin"
                          placeholderTextColor={COLORS.subtleText}
                        />
                      </View>
                      <TouchableOpacity
                        activeOpacity={0.7}
                        onPress={async () => {
                          triggerHaptic('light');
                          const clean = ownerNameInput.trim();
                          await kdbxService.saveProfile({ ownerName: clean });
                          setVaultState((prev) => ({
                            ...prev,
                            ownerName: clean,
                          }));
                          showToast('Adınız kaydedildi');
                        }}
                        style={styles.settingsActionPill}
                      >
                        <Text style={styles.settingsActionPillText}>Kaydet</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                </View>

                {/* GRUP 2: GÜVENLİK */}
                <View style={styles.settingsSection}>
                  <Text style={styles.settingsSectionHeader}>GÜVENLİK</Text>
                  <View style={styles.settingsGroupCard}>
                    {/* Arka Planda Kilitle */}
                    <View style={styles.settingsRow}>
                      <View style={[styles.settingsIconBox, { backgroundColor: 'rgba(16, 185, 129, 0.12)' }]}>
                        <Ionicons name="shield-checkmark" size={16} color={COLORS.emerald} />
                      </View>
                      <View style={{ flex: 1, marginRight: 8 }}>
                        <Text style={styles.settingRowTitle}>Arka Planda Kilitle</Text>
                        <Text style={styles.settingRowSubtitle}>Uygulamadan çıkıldığında anında kilitler</Text>
                      </View>
                      <Switch
                        value={autoLockOnBackground}
                        onValueChange={async (next) => {
                          triggerHaptic('light');
                          setAutoLockOnBackground(next);
                          await kdbxService.saveProfile({ autoLockOnBackground: next });
                          showToast(next ? 'Arka planda kilitleme aktif' : 'Arka planda kilitleme kapatıldı');
                        }}
                        trackColor={{ false: 'rgba(255, 255, 255, 0.1)', true: '#FFFFFF' }}
                        thumbColor={autoLockOnBackground ? '#08090C' : '#8E92A4'}
                      />
                    </View>

                    {biometricSupported && (
                      <>
                        <View style={styles.settingsDivider} />
                        {/* Biyometrik Kilit */}
                        <View style={styles.settingsRow}>
                          <View style={[styles.settingsIconBox, { backgroundColor: 'rgba(255, 255, 255, 0.08)' }]}>
                            <Ionicons name="finger-print" size={16} color="#FFFFFF" />
                          </View>
                          <View style={{ flex: 1, marginRight: 8 }}>
                            <Text style={styles.settingRowTitle}>Biyometrik Kilit</Text>
                            <Text style={styles.settingRowSubtitle}>Parmak izi veya yüz tanıma ile aç</Text>
                          </View>
                          <Switch
                            value={biometricEnabledForActive}
                            onValueChange={async (next) => {
                              triggerHaptic('light');
                              isSystemDialogOpenRef.current = true;
                              try {
                                const result = await kdbxService.setBiometricForCurrentVault(next);
                                setBiometricEnabledForActive(result);
                                showToast(result ? 'Biyometrik kilit açıldı' : 'Biyometrik kilit kapatıldı');
                              } catch (err: unknown) {
                                Alert.alert('Biyometrik Giriş', err instanceof Error ? err.message : 'İşlem tamamlanamadı.');
                              } finally {
                                setTimeout(() => { isSystemDialogOpenRef.current = false; }, 600);
                              }
                            }}
                            trackColor={{ false: 'rgba(255, 255, 255, 0.1)', true: '#FFFFFF' }}
                            thumbColor={biometricEnabledForActive ? '#08090C' : '#8E92A4'}
                          />
                        </View>
                      </>
                    )}

                    <View style={styles.settingsDivider} />

                    {/* Ekran Görüntüsü & Casus Yazılım Koruması */}
                    <View style={styles.settingsRow}>
                      <View style={[styles.settingsIconBox, { backgroundColor: 'rgba(239, 68, 68, 0.12)' }]}>
                        <Ionicons name="eye-off" size={16} color={COLORS.dangerRed} />
                      </View>
                      <View style={{ flex: 1, marginRight: 8 }}>
                        <Text style={styles.settingRowTitle}>Ekran Kaydı & Casus Koruması</Text>
                        <Text style={styles.settingRowSubtitle}>Ekran görüntüsü ve video kaydını engeller (FLAG_SECURE)</Text>
                      </View>
                      <Switch
                        value={screenSecurityEnabled}
                        onValueChange={(next) => {
                          triggerHaptic('light');
                          setScreenSecurityEnabled(next);
                          showToast(next ? 'Ekran koruması açıldı' : 'Ekran koruması kapatıldı');
                        }}
                        trackColor={{ false: 'rgba(255, 255, 255, 0.1)', true: '#FFFFFF' }}
                        thumbColor={screenSecurityEnabled ? '#08090C' : '#8E92A4'}
                      />
                    </View>

                    <View style={styles.settingsDivider} />

                    {/* Ana Şifre Değiştir */}
                    <TouchableOpacity
                      activeOpacity={0.7}
                      onPress={() => {
                        triggerHaptic('light');
                        setChangePwSectionOpen((v) => !v);
                      }}
                      style={styles.settingsRow}
                    >
                      <View style={[styles.settingsIconBox, { backgroundColor: 'rgba(245, 158, 11, 0.12)' }]}>
                        <Ionicons name="key" size={16} color={COLORS.amber} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.settingRowTitle}>Kasa Ana Şifresi</Text>
                        <Text style={styles.settingRowSubtitle}>Kasanın ana şifresini güncelleyin</Text>
                      </View>
                      <Ionicons
                        name={changePwSectionOpen ? 'chevron-down' : 'chevron-forward'}
                        size={16}
                        color={COLORS.mutedForeground}
                      />
                    </TouchableOpacity>

                    {changePwSectionOpen && (
                      <View style={styles.changePwExpandBox}>
                        <TextInput
                          style={styles.settingsInputBox}
                          placeholder="Mevcut ana şifreniz"
                          placeholderTextColor={COLORS.subtleText}
                          secureTextEntry
                          value={currentMasterPwInput}
                          onChangeText={setCurrentMasterPwInput}
                          autoCapitalize="none"
                        />
                        <TextInput
                          style={styles.settingsInputBox}
                          placeholder="Yeni ana şifre"
                          placeholderTextColor={COLORS.subtleText}
                          secureTextEntry
                          value={newMasterPwInput}
                          onChangeText={setNewMasterPwInput}
                          autoCapitalize="none"
                        />
                        <TextInput
                          style={styles.settingsInputBox}
                          placeholder="Yeni ana şifre tekrarı"
                          placeholderTextColor={COLORS.subtleText}
                          secureTextEntry
                          value={confirmNewMasterPwInput}
                          onChangeText={setConfirmNewMasterPwInput}
                          autoCapitalize="none"
                        />
                        <TouchableOpacity
                          activeOpacity={0.85}
                          onPress={handleChangeMasterPassword}
                          style={styles.settingsSubmitButton}
                        >
                          <Text style={styles.settingsSubmitButtonText}>Yeni Ana Şifreyi Kaydet</Text>
                        </TouchableOpacity>
                      </View>
                    )}
                  </View>
                </View>

                {/* GRUP 3: SENKRONİZASYON & BULUT */}
                <View style={styles.settingsSection}>
                  <Text style={styles.settingsSectionHeader}>SENKRONİZASYON & BULUT</Text>
                  <View style={styles.settingsGroupCard}>
                    {/* Keyra Web PC Bağlantısı */}
                    <View style={styles.settingsRow}>
                      <View style={[styles.settingsIconBox, { backgroundColor: 'rgba(56, 189, 248, 0.12)' }]}>
                        <Ionicons name="laptop-outline" size={16} color={COLORS.cyanAccent} />
                      </View>
                      <View style={{ flex: 1, marginRight: 8 }}>
                        <Text style={styles.settingRowTitle}>Keyra Web (PC)</Text>
                        <Text style={styles.settingRowSubtitle}>PC ekranındaki QR'ı tara, tarayıcıda aç</Text>
                      </View>
                      <TouchableOpacity
                        activeOpacity={0.7}
                        onPress={handleOpenQrScanner}
                        style={styles.settingsActionPill}
                      >
                        <Ionicons name="scan-outline" size={13} color="#FFFFFF" style={{ marginRight: 4 }} />
                        <Text style={styles.settingsActionPillText}>Tara</Text>
                      </TouchableOpacity>
                    </View>

                    <View style={styles.settingsDivider} />

                    {/* Cihazlar Arası QR */}
                    <View style={styles.settingsRow}>
                      <View style={[styles.settingsIconBox, { backgroundColor: 'rgba(148, 163, 184, 0.12)' }]}>
                        <Ionicons name="qr-code-outline" size={16} color="#CBD5E1" />
                      </View>
                      <View style={{ flex: 1, marginRight: 6 }}>
                        <Text style={styles.settingRowTitle}>Cihazlar Arası QR</Text>
                        <Text style={styles.settingRowSubtitle}>Telefonlar arasında doğrudan aktarın</Text>
                      </View>
                      <View style={{ flexDirection: 'row', gap: 6 }}>
                        <TouchableOpacity
                          activeOpacity={0.7}
                          onPress={handleOpenQrShare}
                          style={[styles.settingsActionPill, { paddingHorizontal: 10 }]}
                        >
                          <Text style={styles.settingsActionPillText}>Göster</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          activeOpacity={0.7}
                          onPress={handleOpenQrScanner}
                          style={[styles.settingsActionPill, { paddingHorizontal: 10 }]}
                        >
                          <Text style={styles.settingsActionPillText}>Tara</Text>
                        </TouchableOpacity>
                      </View>
                    </View>

                    <View style={styles.settingsDivider} />

                    {/* Google Drive Eşitleme */}
                    <View style={styles.settingsRow}>
                      <View style={[styles.settingsIconBox, { backgroundColor: 'rgba(234, 67, 53, 0.12)' }]}>
                        <Ionicons name="logo-google" size={16} color="#EA4335" />
                      </View>
                      <View style={{ flex: 1, marginRight: 6 }}>
                        <Text style={styles.settingRowTitle}>Google Drive</Text>
                        <Text style={styles.settingRowSubtitle} numberOfLines={1}>
                          {gdriveState.isConnected
                            ? `Bağlı (${gdriveState.lastSyncTime ? gdriveState.lastSyncTime : 'Eşitlenmedi'})`
                            : 'Kasanızı Google Drive ile eşitleyin'}
                        </Text>
                      </View>
                      {gdriveState.isConnected ? (
                        <View style={{ flexDirection: 'row', gap: 6 }}>
                          <TouchableOpacity
                            activeOpacity={0.7}
                            disabled={gdriveState.isSyncing}
                            onPress={handleSyncWithGoogleDrive}
                            style={[styles.settingsActionPill, { backgroundColor: '#FFFFFF' }]}
                          >
                            {gdriveState.isSyncing ? (
                              <ActivityIndicator size="small" color="#08090C" />
                            ) : (
                              <Text style={[styles.settingsActionPillText, { color: '#08090C', fontWeight: '700' }]}>Eşitle</Text>
                            )}
                          </TouchableOpacity>
                          <TouchableOpacity
                            activeOpacity={0.7}
                            onPress={handleDisconnectGoogleDrive}
                            style={[styles.settingsActionPill, { borderColor: 'rgba(239, 68, 68, 0.35)', backgroundColor: 'rgba(239, 68, 68, 0.08)' }]}
                          >
                            <Text style={[styles.settingsActionPillText, { color: COLORS.dangerRed }]}>Ayrıl</Text>
                          </TouchableOpacity>
                        </View>
                      ) : (
                        <TouchableOpacity
                          activeOpacity={0.7}
                          onPress={() => setShowTokenInput(true)}
                          style={styles.settingsActionPill}
                        >
                          <Text style={styles.settingsActionPillText}>Bağlan</Text>
                        </TouchableOpacity>
                      )}
                    </View>

                    {showTokenInput && (
                      <View style={styles.changePwExpandBox}>
                        <Text style={[styles.fieldLabel, { fontSize: 10 }]}>GOOGLE ACCESS TOKEN</Text>
                        <TextInput
                          style={styles.settingsInputBox}
                          placeholder="OAuth Access Token yapıştırın..."
                          placeholderTextColor={COLORS.subtleText}
                          value={googleTokenInput}
                          onChangeText={setGoogleTokenInput}
                          autoCapitalize="none"
                        />
                        <View style={{ flexDirection: 'row', gap: 8 }}>
                          <TouchableOpacity
                            activeOpacity={0.85}
                            onPress={handleSaveGoogleToken}
                            style={[styles.settingsSubmitButton, { flex: 1, height: 40 }]}
                          >
                            <Text style={[styles.settingsSubmitButtonText, { fontSize: 12 }]}>Kaydet</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            activeOpacity={0.7}
                            onPress={() => setShowTokenInput(false)}
                            style={[styles.settingsSecondaryBtn, { height: 40, paddingHorizontal: 14 }]}
                          >
                            <Text style={styles.settingsSecondaryBtnText}>İptal</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    )}
                  </View>
                </View>

                {/* GRUP 4: KASA YÖNETİMİ & DOSYALAR */}
                <View style={styles.settingsSection}>
                  <Text style={styles.settingsSectionHeader}>KASA DOSYASI & YEDEK</Text>
                  <View style={styles.settingsGroupCard}>
                    {Array.from(new Set([vaultState.fileName, ...knownVaults])).map((vaultFile, idx, arr) => {
                      const isCurrent = vaultFile === vaultState.fileName;
                      return (
                        <React.Fragment key={vaultFile}>
                          <View style={styles.settingsRow}>
                            <View style={[styles.settingsIconBox, { backgroundColor: isCurrent ? 'rgba(16, 185, 129, 0.12)' : 'rgba(255, 255, 255, 0.05)' }]}>
                              <Ionicons name="folder-outline" size={16} color={isCurrent ? COLORS.emerald : '#8E92A4'} />
                            </View>
                            <View style={{ flex: 1, marginRight: 8 }}>
                              <Text style={styles.settingRowTitle} numberOfLines={1}>{vaultFile}</Text>
                              <Text style={styles.settingRowSubtitle}>
                                {isCurrent ? 'Aktif Açık Kasa' : 'Kayıtlı Kasa'}
                              </Text>
                            </View>
                            <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                              {!isCurrent && (
                                <TouchableOpacity
                                  activeOpacity={0.7}
                                  onPress={async () => {
                                    triggerHaptic('light');
                                    setSettingsModalOpen(false);
                                    handleLock(true);
                                    await handleSelectKnownVault(vaultFile);
                                    setAuthMode('unlock');
                                  }}
                                  style={styles.settingsActionPill}
                                >
                                  <Text style={styles.settingsActionPillText}>Aç</Text>
                                </TouchableOpacity>
                              )}
                              <TouchableOpacity
                                activeOpacity={0.7}
                                onPress={() => {
                                  triggerHaptic('medium');
                                  handleDeleteVaultFile(vaultFile);
                                }}
                                style={styles.settingsTrashBtn}
                              >
                                <Ionicons name="trash-outline" size={15} color={COLORS.dangerRed} />
                              </TouchableOpacity>
                            </View>
                          </View>
                          <View style={styles.settingsDivider} />
                        </React.Fragment>
                      );
                    })}

                    {/* Dışa Aktar */}
                    <TouchableOpacity
                      activeOpacity={0.7}
                      onPress={async () => {
                        triggerHaptic('light');
                        isSystemDialogOpenRef.current = true;
                        try {
                          await kdbxService.exportCurrentVault();
                        } catch (err: unknown) {
                          Alert.alert('Dışa Aktar', err instanceof Error ? err.message : 'Kasa dışa aktarılamadı.');
                        } finally {
                          setTimeout(() => { isSystemDialogOpenRef.current = false; }, 600);
                        }
                      }}
                      style={styles.settingsRow}
                    >
                      <View style={[styles.settingsIconBox, { backgroundColor: 'rgba(255, 255, 255, 0.08)' }]}>
                        <Feather name="share-2" size={15} color="#FFFFFF" />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.settingRowTitle}>Kasa Dosyasını Dışa Aktar</Text>
                        <Text style={styles.settingRowSubtitle}>.kdbx dosyasını paylaşın veya yedekleyin</Text>
                      </View>
                      <Ionicons name="chevron-forward" size={16} color={COLORS.mutedForeground} />
                    </TouchableOpacity>

                    <View style={styles.settingsDivider} />

                    {/* Cihazdan Başka .kdbx Yükle */}
                    <TouchableOpacity
                      activeOpacity={0.7}
                      onPress={async () => {
                        triggerHaptic('light');
                        setSettingsModalOpen(false);
                        handleLock(true);
                        await handleImportKdbxFile();
                      }}
                      style={styles.settingsRow}
                    >
                      <View style={[styles.settingsIconBox, { backgroundColor: 'rgba(56, 189, 248, 0.12)' }]}>
                        <Feather name="folder-plus" size={15} color={COLORS.cyanAccent} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.settingRowTitle}>Cihazdan .kdbx Yükle</Text>
                        <Text style={styles.settingRowSubtitle}>Dosya yöneticisinden başka kasa açın</Text>
                      </View>
                      <Ionicons name="chevron-forward" size={16} color={COLORS.mutedForeground} />
                    </TouchableOpacity>
                  </View>
                </View>

                {/* GRUP 5: OTURUM & ÇIKIŞ */}
                <View style={[styles.settingsSection, { marginBottom: 16 }]}>
                  <View style={styles.settingsGroupCard}>
                    <TouchableOpacity
                      activeOpacity={0.7}
                      onPress={() => {
                        triggerHaptic('medium');
                        setSettingsModalOpen(false);
                        handleLock(false);
                        setAuthMode('welcome');
                      }}
                      style={styles.settingsRow}
                    >
                      <View style={[styles.settingsIconBox, { backgroundColor: 'rgba(239, 68, 68, 0.12)' }]}>
                        <Ionicons name="log-out-outline" size={16} color={COLORS.dangerRed} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.settingRowTitle, { color: COLORS.dangerRed }]}>Kasayı Kilitle ve Başlangıca Dön</Text>
                        <Text style={styles.settingRowSubtitle}>Kasa şifresi olmadan erişilemez</Text>
                      </View>
                      <Ionicons name="chevron-forward" size={16} color={COLORS.dangerRed} />
                    </TouchableOpacity>
                  </View>
                </View>
              </ScrollView>
            </View>
          </KeyboardAvoidingView>
        </Modal>

        {/* =========================================================
           QR KOD İLE PAYLAŞMA & EŞLEME MODALI
           ========================================================= */}
        <Modal
          visible={qrModalOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setQrModalOpen(false)}
        >
          <View style={styles.sheetBackdrop}>
            <View style={[styles.sheetCard, { alignItems: 'center' }]}>
              <View style={styles.sheetHandle} />

              <View style={[styles.sheetHeader, { width: '100%' }]}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Ionicons name="qr-code" size={20} color={COLORS.cyanAccent} style={{ marginRight: 8 }} />
                  <Text style={styles.sheetTitle}>Cihaz Eşleme QR Kodu</Text>
                </View>
                <TouchableOpacity
                  onPress={() => setQrModalOpen(false)}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  style={styles.closeIconButton}
                >
                  <Ionicons name="close" size={20} color={COLORS.mutedForeground} />
                </TouchableOpacity>
              </View>

              <Text style={{ fontSize: 13, color: COLORS.mutedForeground, textAlign: 'center', marginVertical: 8 }}>
                Diğer telefon veya bilgisayarınızdaki Keyra uygulamasıyla bu QR kodu tarayın.
              </Text>

              {/* QR Kod Çerçevesi */}
              <View style={styles.qrCodeWrapper}>
                {qrPayloadString ? (
                  <QRCode
                    value={qrPayloadString}
                    size={210}
                    color="#000000"
                    backgroundColor="#FFFFFF"
                  />
                ) : (
                  <ActivityIndicator size="large" color={COLORS.primary} />
                )}
              </View>

              {qrPairingPin ? (
                <View style={styles.pinDisplayBox}>
                  <Text style={styles.pinDisplayLabel}>GÜVENLİK PIN KODU</Text>
                  <Text style={styles.pinDisplayText}>{qrPairingPin}</Text>
                </View>
              ) : null}

              <TouchableOpacity
                onPress={() => setQrModalOpen(false)}
                style={[styles.unlockButton, { width: '100%', marginTop: 14 }]}
              >
                <Text style={styles.unlockButtonText}>Tamam</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        {/* =========================================================
           QR KOD KAMERA İLE TARAMA MODALI
           ========================================================= */}
        <Modal
          visible={scannerModalOpen}
          animationType="slide"
          onRequestClose={handleCloseScanner}
        >
          <View style={{ flex: 1, backgroundColor: '#000000' }}>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{
                barcodeTypes: ['qr'],
              }}
              onBarcodeScanned={handleBarcodeScanned}
            />

            {/* Kamera Üzeri Hedef Çerçevesi */}
            <View style={styles.scannerOverlay}>
              <View style={styles.scannerHeader}>
                <Text style={styles.scannerTitle}>Keyra QR Kodunu Hizalayın</Text>
                <TouchableOpacity
                  onPress={handleCloseScanner}
                  style={styles.scannerCloseButton}
                >
                  <Ionicons name="close" size={24} color="#FFFFFF" />
                </TouchableOpacity>
              </View>

              <View style={styles.scannerTargetBox}>
                <View style={[styles.scannerCorner, styles.cornerTL]} />
                <View style={[styles.scannerCorner, styles.cornerTR]} />
                <View style={[styles.scannerCorner, styles.cornerBL]} />
                <View style={[styles.scannerCorner, styles.cornerBR]} />
              </View>

              <Text style={styles.scannerHint}>
                Diğer cihazın ekranındaki QR kodu karenin içine getirin
              </Text>
            </View>
          </View>
        </Modal>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.background,
    paddingTop: Platform.OS === 'android' ? RNStatusBar.currentHeight ?? 24 : 44,
  },
  root: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  toastBanner: {
    position: 'absolute',
    top: 12,
    left: 20,
    right: 20,
    zIndex: 100,
    backgroundColor: '#161722',
    borderColor: 'rgba(255, 255, 255, 0.14)',
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 11,
    paddingHorizontal: 16,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 8,
  },
  toastText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '500',
    letterSpacing: -0.1,
  },

  // --- BAŞLANGIÇ & GİRİŞ EKRANI ---
  lockScrollContent: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: 36,
    justifyContent: 'center',
  },
  lockHero: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 24,
    gap: 12,
  },
  logoImageWrap: {
    width: 84,
    height: 84,
    borderRadius: 24,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 10,
    backgroundColor: '#111218',
  },
  logoImage: {
    width: '100%',
    height: '100%',
  },
  lockBrandWrap: {
    alignItems: 'center',
    gap: 6,
  },
  lockBrandTitle: {
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: -0.5,
    color: '#FFFFFF',
  },
  lockBrandSubtitle: {
    fontSize: 13,
    fontWeight: '400',
    color: '#8E92A4',
    letterSpacing: -0.1,
  },
  activeVaultPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    marginTop: 4,
  },
  activeVaultPillText: {
    fontSize: 12,
    fontWeight: '500',
    color: '#8E92A4',
    letterSpacing: 0.1,
  },
  vaultChipsScroll: {
    flexDirection: 'row',
    paddingVertical: 6,
    gap: 8,
    marginBottom: 12,
    justifyContent: 'center',
  },
  vaultChip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.07)',
  },
  vaultChipActive: {
    backgroundColor: '#FFFFFF',
    borderColor: '#FFFFFF',
  },
  vaultChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#8E92A4',
  },
  vaultChipTextActive: {
    color: '#08090C',
  },
  passwordCard: {
    backgroundColor: COLORS.card,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.07)',
    padding: 18,
    gap: 14,
  },
  biometricButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 48,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
  },
  biometricButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  lockFooterLinks: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 24,
    gap: 10,
  },
  footerLinkBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  footerLinkText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#8E92A4',
  },
  footerDot: {
    width: 3,
    height: 3,
    borderRadius: 2,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
  },
  createTopNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 16,
  },
  createBackBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingVertical: 6,
    paddingRight: 10,
  },
  createBackText: {
    fontSize: 15,
    fontWeight: '500',
    color: '#8E92A4',
  },
  createTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#FFFFFF',
    letterSpacing: -0.3,
  },
  groupedFormCard: {
    backgroundColor: COLORS.card,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.07)',
    padding: 16,
  },
  formRow: {
    paddingVertical: 8,
  },
  formRowLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#55596D',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  formRowInput: {
    fontSize: 15,
    color: '#FFFFFF',
    height: 36,
    paddingVertical: 0,
  },
  formDivider: {
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    marginVertical: 6,
  },
  inputInnerRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  formRowInputInner: {
    flex: 1,
    fontSize: 15,
    color: '#FFFFFF',
    height: 36,
    paddingVertical: 0,
  },
  welcomeIntroCard: {
    backgroundColor: COLORS.card,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.07)',
    padding: 18,
    gap: 12,
  },
  introFeatureRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  introFeatureText: {
    flex: 1,
    fontSize: 13,
    color: '#8E92A4',
    lineHeight: 18,
  },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 50,
    borderRadius: 14,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  secondaryButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 4,
  },
  checkboxBox: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxBoxChecked: {
    borderColor: COLORS.primary,
    backgroundColor: COLORS.primary,
  },
  checkboxTick: {
    fontSize: 12,
    fontWeight: '800',
    color: COLORS.primaryForeground,
  },
  checkboxLabel: {
    fontSize: 13,
    color: COLORS.foreground,
  },
  lockForm: {
    gap: 16,
  },
  fieldGroup: {
    gap: 8,
  },
  fieldLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  fieldLabel: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.8,
    color: COLORS.mutedForeground,
  },
  passwordBox: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
    paddingLeft: 14,
    paddingRight: 6,
  },
  passwordBoxFocused: {
    borderColor: '#FFFFFF',
    backgroundColor: '#16171E',
  },
  verifiedDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#10B981',
    marginLeft: 6,
  },
  passwordInput: {
    flex: 1,
    fontSize: 14,
    color: COLORS.foreground,
  },
  eyeButton: {
    paddingHorizontal: 10,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  eyeIconText: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.mutedForeground,
  },
  strengthRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  strengthBars: {
    flex: 1,
    flexDirection: 'row',
    gap: 4,
  },
  strengthSegment: {
    flex: 1,
    height: 4,
    borderRadius: 999,
  },
  strengthPrimary: {
    backgroundColor: COLORS.emerald,
  },
  strengthDestructive: {
    backgroundColor: COLORS.destructive,
  },
  strengthInactive: {
    backgroundColor: COLORS.border,
  },
  strengthLabel: {
    fontSize: 11,
    color: COLORS.mutedForeground,
  },
  errorBanner: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 77, 109, 0.4)',
    backgroundColor: 'rgba(255, 77, 109, 0.08)',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  errorBannerText: {
    fontSize: 12,
    lineHeight: 17,
    color: COLORS.dangerRed,
  },
  unlockButton: {
    height: 50,
    borderRadius: 10,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  derivingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  unlockButtonDisabled: {
    opacity: 0.4,
  },
  unlockButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.primaryForeground,
  },

  // --- VAULT DASHBOARD ---
  dashboardContainer: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  dashHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 14,
  },
  dashHeaderLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 12,
  },
  dashLogoMini: {
    width: 36,
    height: 36,
    borderRadius: 10,
    marginRight: 10,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
  },
  dashBrandName: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.foreground,
    letterSpacing: 0.2,
  },
  unlockedText: {
    fontSize: 12,
    color: COLORS.mutedForeground,
  },
  vaultFileName: {
    fontSize: 11,
    fontWeight: '500',
    color: COLORS.subtleText,
    marginTop: 1,
  },
  dashHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerIconButton: {
    width: 38,
    height: 38,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerLockIconButton: {
    width: 38,
    height: 38,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.35)',
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchSection: {
    paddingHorizontal: 20,
  },
  searchBar: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
    paddingHorizontal: 12,
  },
  searchBarInput: {
    flex: 1,
    fontSize: 14,
    color: COLORS.foreground,
  },
  clearQueryText: {
    fontSize: 12,
    color: COLORS.mutedForeground,
  },
  filtersWrapper: {
    paddingVertical: 12,
  },
  filtersScroll: {
    paddingHorizontal: 20,
    gap: 8,
  },
  filterPill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 13,
    paddingVertical: 7,
  },
  filterPillActive: {
    borderColor: COLORS.primary,
    backgroundColor: COLORS.primary,
  },
  filterPillInactive: {
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
  },
  filterPillText: {
    fontSize: 12,
    fontWeight: '600',
  },
  filterPillTextActive: {
    color: '#08090C',
  },
  filterPillTextInactive: {
    color: COLORS.mutedForeground,
  },
  entriesSection: {
    flex: 1,
    paddingHorizontal: 20,
  },
  entriesListContent: {
    gap: 10,
    paddingBottom: 96,
  },

  // --- KAYIT KARTI (HUMAN CRAFTED LIST ROW) ---
  entryCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.07)',
    backgroundColor: COLORS.card,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  monogramBox: {
    width: 44,
    height: 44,
    borderRadius: 13,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  monogramText: {
    fontFamily: MONO_FONT,
    fontSize: 14,
    fontWeight: '700',
  },
  entryCenter: {
    flex: 1,
    justifyContent: 'center',
    gap: 2,
  },
  entryTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  entryTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#FFFFFF',
    letterSpacing: -0.2,
    maxWidth: '75%',
  },
  entryHostBadgeWrap: {
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderRadius: 5,
    paddingHorizontal: 5,
    paddingVertical: 1.5,
  },
  entryHostBadge: {
    fontSize: 10,
    fontWeight: '500',
    color: '#8E92A4',
  },
  entrySubtitle: {
    fontSize: 12,
    color: '#55596D',
    letterSpacing: -0.1,
  },
  entryRightActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  quickCopyButton: {
    width: 36,
    height: 36,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.07)',
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickCopyButtonCopied: {
    borderColor: 'rgba(16, 185, 129, 0.45)',
    backgroundColor: 'rgba(16, 185, 129, 0.14)',
  },
  copyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 36,
    paddingHorizontal: 12,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
    justifyContent: 'center',
  },
  copyButtonActive: {
    borderColor: 'rgba(16, 185, 129, 0.4)',
    backgroundColor: 'rgba(16, 185, 129, 0.12)',
  },
  copyButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.mutedForeground,
  },
  copyButtonTextActive: {
    color: COLORS.emerald,
  },
  emptySearchBox: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
    padding: 32,
    alignItems: 'center',
    gap: 6,
    marginTop: 12,
  },
  emptySearchTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.foreground,
  },
  emptySearchSubtitle: {
    fontSize: 12,
    color: COLORS.mutedForeground,
    textAlign: 'center',
    marginBottom: 12,
  },
  emptyAddBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    backgroundColor: COLORS.primary,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  emptyAddBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.primaryForeground,
  },

  // --- FAB ---
  fabButton: {
    position: 'absolute',
    right: 20,
    bottom: 24,
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.45,
    shadowRadius: 14,
    elevation: 8,
  },
  fabIcon: {
    fontSize: 26,
    color: COLORS.primaryForeground,
    fontWeight: '700',
    lineHeight: 28,
  },

  // --- MODALLAR ---
  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    justifyContent: 'flex-end',
  },
  sheetCard: {
    maxHeight: '92%',
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    borderTopWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    backgroundColor: COLORS.card,
    paddingHorizontal: 22,
    paddingTop: 12,
    paddingBottom: 34,
    gap: 14,
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255, 255, 255, 0.18)',
    marginBottom: 4,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  detailTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
  },
  detailMonogramBadge: {
    width: 40,
    height: 40,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  detailMonogramText: {
    fontFamily: MONO_FONT,
    fontSize: 13,
    fontWeight: '700',
  },
  detailCategoryLabel: {
    fontSize: 11,
    color: COLORS.mutedForeground,
    marginTop: 2,
  },
  sheetTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.foreground,
  },
  closeIconButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  detailRowBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
    padding: 13,
  },
  detailValueMono: {
    fontFamily: MONO_FONT,
    fontSize: 13,
    color: COLORS.foreground,
    marginTop: 4,
  },
  strengthMeterContainer: {
    flexDirection: 'row',
    gap: 4,
    height: 3,
    marginTop: 6,
  },
  inlinePillGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  detailCopyPill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 7,
    backgroundColor: COLORS.surfaceLight,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  detailCopyPillText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  detailActionButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  deleteIconButton: {
    width: 50,
    height: 50,
    borderRadius: 12,
    backgroundColor: 'rgba(239, 68, 68, 0.16)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryOutlineButton: {
    height: 48,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryOutlineText: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.foreground,
  },
  deleteEntryButton: {
    height: 50,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.35)',
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteEntryButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.dangerRed,
  },
  modalFieldGroup: {
    gap: 6,
  },
  modalInputBox: {
    height: 46,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
    paddingHorizontal: 14,
    fontSize: 14,
    color: COLORS.foreground,
  },
  regenerateLink: {
    fontSize: 12,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  generatorOptionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  generatorLengthsGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  genOptionPill: {
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
  },
  genOptionPillActive: {
    borderColor: '#FFFFFF',
    backgroundColor: '#FFFFFF',
  },
  genOptionPillText: {
    fontFamily: MONO_FONT,
    fontSize: 11,
    fontWeight: '600',
    color: COLORS.mutedForeground,
  },
  genOptionPillTextActive: {
    color: '#08090C',
  },
  // --- MODERN SETTINGS INSET GROUPED STYLES ---
  settingsSection: {
    gap: 7,
  },
  settingsSectionHeader: {
    fontSize: 11,
    fontWeight: '700',
    color: '#55596D',
    letterSpacing: 0.7,
    textTransform: 'uppercase',
    paddingHorizontal: 4,
  },
  settingsGroupCard: {
    backgroundColor: '#111218',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.07)',
    overflow: 'hidden',
  },
  settingsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 15,
    paddingVertical: 13,
    gap: 12,
  },
  settingsIconBox: {
    width: 32,
    height: 32,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  settingRowTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
    letterSpacing: -0.2,
  },
  settingRowSubtitle: {
    fontSize: 12,
    color: '#8E92A4',
    marginTop: 2,
    letterSpacing: -0.1,
  },
  settingsDivider: {
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    marginLeft: 58,
  },
  settingsInlineInput: {
    fontSize: 13,
    color: '#FFFFFF',
    height: 28,
    paddingVertical: 0,
    marginTop: 2,
  },
  settingsActionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
  },
  settingsActionPillText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  settingsTrashBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
  },
  changePwExpandBox: {
    padding: 14,
    backgroundColor: '#0E0F15',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.06)',
    gap: 10,
  },
  settingsInputBox: {
    height: 42,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    backgroundColor: '#151620',
    paddingHorizontal: 14,
    fontSize: 13,
    color: '#FFFFFF',
  },
  settingsSubmitButton: {
    height: 44,
    borderRadius: 10,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  settingsSubmitButtonText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#08090C',
  },
  settingsSecondaryBtn: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  settingsSecondaryBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#8E92A4',
  },
  settingTitleText: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.foreground,
  },
  settingSubText: {
    fontSize: 11,
    color: COLORS.mutedForeground,
    marginTop: 2,
  },
  changePwBox: {
    gap: 10,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
    marginTop: 4,
  },
  qrCodeWrapper: {
    backgroundColor: '#FFFFFF',
    padding: 18,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 12,
    alignSelf: 'center',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 6,
  },
  pinDisplayBox: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 20,
    marginTop: 6,
  },
  pinDisplayLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
    color: '#8E92A4',
    marginBottom: 4,
  },
  pinDisplayText: {
    fontFamily: MONO_FONT,
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: 6,
    color: COLORS.foreground,
  },
  scannerOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  scannerHeader: {
    position: 'absolute',
    top: Platform.OS === 'android' ? (RNStatusBar.currentHeight ?? 24) + 16 : 56,
    left: 20,
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    zIndex: 10,
  },
  scannerTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  scannerCloseButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  scannerTargetBox: {
    width: 250,
    height: 250,
    position: 'relative',
    backgroundColor: 'transparent',
  },
  scannerCorner: {
    position: 'absolute',
    width: 32,
    height: 32,
    borderColor: COLORS.primary,
  },
  cornerTL: {
    top: 0,
    left: 0,
    borderTopWidth: 4,
    borderLeftWidth: 4,
    borderTopLeftRadius: 12,
  },
  cornerTR: {
    top: 0,
    right: 0,
    borderTopWidth: 4,
    borderRightWidth: 4,
    borderTopRightRadius: 12,
  },
  cornerBL: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 4,
    borderLeftWidth: 4,
    borderBottomLeftRadius: 12,
  },
  cornerBR: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 4,
    borderRightWidth: 4,
    borderBottomRightRadius: 12,
  },
  scannerHint: {
    marginTop: 28,
    fontSize: 13,
    color: 'rgba(255, 255, 255, 0.85)',
    textAlign: 'center',
    paddingHorizontal: 20,
  },
});
