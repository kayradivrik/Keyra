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
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Clipboard from 'expo-clipboard';
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
  background: '#000000',
  foreground: '#e4e4e7',
  card: '#0d0d0e',
  surface: '#161618',
  primary: '#f2f2f2',
  primaryForeground: '#000000',
  mutedForeground: '#8a8a93',
  destructive: '#b7b7bd',
  border: '#222225',
  dangerRed: '#ff4d6d',
};

const MONO_FONT = Platform.OS === 'ios' ? 'Menlo' : 'monospace';
const CLIPBOARD_CLEAR_MS = 30000;

function scorePassword(value: string): number {
  let score = 0;
  if (value.length >= 8) score++;
  if (value.length >= 14) score++;
  if (/[A-Z]/.test(value) && /[a-z]/.test(value)) score++;
  if (/\d/.test(value) && /[^A-Za-z0-9]/.test(value)) score++;
  return Math.min(score, 4);
}

const STRENGTH_LABELS = ['Boş', 'Zayıf', 'Orta', 'Güçlü', 'Çok Güçlü'];
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

  const handleCopy = () => {
    onCopyText(entry.password, `${entry.title} şifresi`);
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1500);
  };

  const monogram = entry.monogram || deriveMonogram(entry.title);

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={() => onOpenDetail(entry)}
      style={styles.entryCard}
    >
      <View style={styles.monogramBox}>
        <Text style={styles.monogramText}>{monogram}</Text>
      </View>

      <View style={styles.entryCenter}>
        <Text style={styles.entryTitle} numberOfLines={1}>
          {entry.title}
        </Text>
        {entry.username ? (
          <Text style={styles.entryUsername} numberOfLines={1}>
            {entry.username}
          </Text>
        ) : null}
        <TouchableOpacity
          onPress={() => setRevealed((r) => !r)}
          style={styles.secretToggleWrap}
        >
          <Text style={styles.entrySecretMask} numberOfLines={1}>
            {revealed ? entry.password : '••••••••••••'}
          </Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity
        onPress={handleCopy}
        activeOpacity={0.75}
        style={[styles.copyButton, copied && styles.copyButtonActive]}
      >
        <Text
          style={[
            styles.copyButtonText,
            copied && styles.copyButtonTextActive,
          ]}
        >
          {copied ? '✓' : 'Kopyala'}
        </Text>
      </TouchableOpacity>
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

  // Başlangıçta profil ve biyometrik durumu yükle
  useEffect(() => {
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
        await refreshBiometricState(profile.activeVaultFile);
      } catch {
        // Varsayılan değerlerle devam et
      }
    })();

    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      if (clipboardTimerRef.current) clearTimeout(clipboardTimerRef.current);
    };
  }, [refreshBiometricState]);

  // Arka Plana Atınca Otomatik Kilitleme (AppState Dinleyicisi)
  useEffect(() => {
    const subscription = AppState.addEventListener(
      'change',
      (nextState: AppStateStatus) => {
        if (
          nextState === 'background' &&
          vaultState.isUnlocked &&
          autoLockOnBackground &&
          !isSystemDialogOpenRef.current
        ) {
          handleLock(true);
        }
      }
    );

    return () => {
      subscription.remove();
    };
  }, [vaultState.isUnlocked, autoLockOnBackground, handleLock]);

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

  const visibleEntries = useMemo(() => {
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
            <Text style={styles.toastText}>✓ {toastMessage}</Text>
          </View>
        )}

        {!vaultState.isUnlocked ? (
          <ScrollView
            contentContainerStyle={styles.lockScrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {/* Üst Sekme Çubuğu */}
            <View style={styles.modeSwitchBar}>
              <TouchableOpacity
                onPress={() => {
                  setErrorMessage(null);
                  setAuthMode('welcome');
                }}
                style={[
                  styles.modeSwitchTab,
                  authMode === 'welcome' && styles.modeSwitchTabActive,
                ]}
              >
                <Text
                  style={[
                    styles.modeSwitchTabText,
                    authMode === 'welcome' && styles.modeSwitchTabTextActive,
                  ]}
                >
                  Başlangıç
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={goToCreateMode}
                style={[
                  styles.modeSwitchTab,
                  authMode === 'create' && styles.modeSwitchTabActive,
                ]}
              >
                <Text
                  style={[
                    styles.modeSwitchTabText,
                    authMode === 'create' && styles.modeSwitchTabTextActive,
                  ]}
                >
                  Yeni Kasa
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={goToUnlockMode}
                style={[
                  styles.modeSwitchTab,
                  authMode === 'unlock' && styles.modeSwitchTabActive,
                ]}
              >
                <Text
                  style={[
                    styles.modeSwitchTabText,
                    authMode === 'unlock' && styles.modeSwitchTabTextActive,
                  ]}
                >
                  Kasaya Gir
                </Text>
              </TouchableOpacity>
            </View>

            {/* Logo & Başlık */}
            <View style={styles.lockHero}>
              <View style={styles.lockCircleInner}>
                <View style={styles.lockIconShackle} />
                <View style={styles.lockIconBody}>
                  <View style={styles.lockIconKeyholeDot} />
                </View>
              </View>
              <Text style={styles.lockBrandTitle}>Keyra</Text>
            </View>

            {/* =====================================================
               MOD 1: BAŞLANGIÇ EKRANI
               ===================================================== */}
            {authMode === 'welcome' && (
              <View style={styles.lockForm}>
                <View style={styles.welcomeCard}>
                  <Text style={styles.fieldLabel}>ADINIZ</Text>
                  <View style={styles.ownerInputRow}>
                    <View style={styles.ownerAvatarBox}>
                      <Text style={styles.ownerAvatarText}>
                        {deriveMonogram(ownerNameInput || 'AV')}
                      </Text>
                    </View>
                    <TextInput
                      style={styles.ownerTextInput}
                      value={ownerNameInput}
                      onChangeText={handleOwnerNameChange}
                      placeholder="Adınızı girin (Örn: Kuzey)"
                      placeholderTextColor={COLORS.mutedForeground}
                      autoCapitalize="words"
                      autoCorrect={false}
                    />
                  </View>
                </View>

                {errorMessage && (
                  <View style={styles.errorBanner}>
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
                  activeOpacity={0.85}
                  onPress={goToUnlockMode}
                  style={styles.secondaryCardButton}
                >
                  <View>
                    <Text style={styles.secondaryCardTitle}>Kasaya Gir</Text>
                    <Text style={styles.secondaryCardSub}>
                      {knownVaults.length > 0
                        ? `Aktif: ${vaultState.fileName}`
                        : 'Mevcut kasanızı şifrenizle açın'}
                    </Text>
                  </View>
                  <Text style={styles.secondaryCardArrow}>›</Text>
                </TouchableOpacity>

                {biometricSupported && biometricEnabledForActive && (
                  <TouchableOpacity
                    activeOpacity={0.85}
                    onPress={handleBiometricUnlock}
                    style={styles.biometricUnlockButton}
                  >
                    <Text style={styles.biometricUnlockText}>
                      Parmak İzi / Yüz Tanıma ile Hızlı Gir ({vaultState.fileName})
                    </Text>
                  </TouchableOpacity>
                )}

                <TouchableOpacity
                  activeOpacity={0.8}
                  onPress={handleImportKdbxFile}
                  style={styles.importDeviceFullButton}
                >
                  <Text style={styles.importDeviceFullText}>
                    Cihazdan .kdbx Dosyası Yükle
                  </Text>
                </TouchableOpacity>
              </View>
            )}

            {/* =====================================================
               MOD 2: YENİ KASA OLUŞTUR
               ===================================================== */}
            {authMode === 'create' && (
              <View style={styles.lockForm}>
                <View style={styles.fieldGroup}>
                  <Text style={styles.fieldLabel}>ADINIZ</Text>
                  <View style={styles.passwordBox}>
                    <TextInput
                      style={styles.passwordInput}
                      value={ownerNameInput}
                      onChangeText={handleOwnerNameChange}
                      placeholder="Örn: Kuzey"
                      placeholderTextColor={COLORS.mutedForeground}
                      autoCapitalize="words"
                      autoCorrect={false}
                    />
                  </View>
                </View>

                <View style={styles.fieldGroup}>
                  <Text style={styles.fieldLabel}>KASA ADI (.KDBX)</Text>
                  <View style={styles.passwordBox}>
                    <TextInput
                      style={styles.passwordInput}
                      value={customVaultName}
                      onChangeText={(t) => {
                        setCustomVaultName(t);
                        if (errorMessage) setErrorMessage(null);
                      }}
                      placeholder="Örn: Kuzey.kdbx"
                      placeholderTextColor={COLORS.mutedForeground}
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                  </View>
                </View>

                <View style={styles.fieldGroup}>
                  <View style={styles.fieldLabelRow}>
                    <Text style={styles.fieldLabel}>ANA ŞİFRE</Text>
                    <TouchableOpacity onPress={generateMasterPasswordSuggestion}>
                      <Text style={styles.regenerateLink}>Güçlü Şifre Öner</Text>
                    </TouchableOpacity>
                  </View>

                  <View style={styles.passwordBox}>
                    <TextInput
                      style={styles.passwordInput}
                      value={password}
                      onChangeText={(t) => {
                        setPassword(t);
                        if (errorMessage) setErrorMessage(null);
                      }}
                      secureTextEntry={!visiblePassword}
                      placeholder="Kasa şifrenizi belirleyin"
                      placeholderTextColor={COLORS.mutedForeground}
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                    <TouchableOpacity
                      onPress={() => setVisiblePassword((v) => !v)}
                      style={styles.eyeButton}
                    >
                      <Text style={styles.eyeIconText}>
                        {visiblePassword ? 'Gizle' : 'Göster'}
                      </Text>
                    </TouchableOpacity>
                  </View>

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
                </View>

                <View style={styles.fieldGroup}>
                  <Text style={styles.fieldLabel}>ANA ŞİFRE TEKRARI</Text>
                  <View style={styles.passwordBox}>
                    <TextInput
                      style={styles.passwordInput}
                      value={confirmPassword}
                      onChangeText={(t) => {
                        setConfirmPassword(t);
                        if (errorMessage) setErrorMessage(null);
                      }}
                      secureTextEntry={!visiblePassword}
                      placeholder="Şifrenizi tekrar girin"
                      placeholderTextColor={COLORS.mutedForeground}
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
                        <Text style={styles.checkboxTick}>✓</Text>
                      )}
                    </View>
                    <Text style={styles.checkboxLabel}>
                      Parmak İzi / Yüz Tanıma ile girişi etkinleştir
                    </Text>
                  </TouchableOpacity>
                )}

                {errorMessage && (
                  <View style={styles.errorBanner}>
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
               MOD 3: KASAYA GİR
               ===================================================== */}
            {authMode === 'unlock' && (
              <View style={styles.lockForm}>
                <View style={styles.fieldGroup}>
                  <Text style={styles.fieldLabel}>SEÇİLİ KASA</Text>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={{ gap: 8, paddingVertical: 2 }}
                  >
                    {(knownVaults.length > 0
                      ? knownVaults
                      : [vaultState.fileName]
                    ).map((vaultFile) => {
                      const active = vaultState.fileName === vaultFile;
                      return (
                        <TouchableOpacity
                          key={vaultFile}
                          onPress={() => handleSelectKnownVault(vaultFile)}
                          style={[
                            styles.filterPill,
                            active
                              ? styles.filterPillActive
                              : styles.filterPillInactive,
                          ]}
                        >
                          <Text
                            style={[
                              styles.filterPillText,
                              active
                                ? styles.filterPillTextActive
                                : styles.filterPillTextInactive,
                            ]}
                          >
                            {vaultFile}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}

                    <TouchableOpacity
                      onPress={handleImportKdbxFile}
                      style={[styles.filterPill, styles.filterPillInactive]}
                    >
                      <Text
                        style={[
                          styles.filterPillText,
                          { color: COLORS.primary },
                        ]}
                      >
                        + Dosya Seç
                      </Text>
                    </TouchableOpacity>
                  </ScrollView>
                </View>

                <View style={styles.fieldGroup}>
                  <Text style={styles.fieldLabel}>ANA ŞİFRE</Text>
                  <View style={styles.passwordBox}>
                    <TextInput
                      style={styles.passwordInput}
                      value={password}
                      onChangeText={(t) => {
                        setPassword(t);
                        if (errorMessage) setErrorMessage(null);
                      }}
                      secureTextEntry={!visiblePassword}
                      placeholder="Kasa şifrenizi girin"
                      placeholderTextColor={COLORS.mutedForeground}
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                    <TouchableOpacity
                      onPress={() => setVisiblePassword((v) => !v)}
                      style={styles.eyeButton}
                    >
                      <Text style={styles.eyeIconText}>
                        {visiblePassword ? 'Gizle' : 'Göster'}
                      </Text>
                    </TouchableOpacity>
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
                        <Text style={styles.checkboxTick}>✓</Text>
                      )}
                    </View>
                    <Text style={styles.checkboxLabel}>
                      Sonraki girişler için Parmak İzi / Yüz Tanıma kaydet
                    </Text>
                  </TouchableOpacity>
                )}

                {errorMessage && (
                  <View style={styles.errorBanner}>
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
                    <Text style={styles.unlockButtonText}>Kasaya Gir</Text>
                  )}
                </TouchableOpacity>

                {biometricSupported && biometricEnabledForActive && (
                  <TouchableOpacity
                    activeOpacity={0.85}
                    onPress={handleBiometricUnlock}
                    style={styles.biometricUnlockButton}
                  >
                    <Text style={styles.biometricUnlockText}>
                      Parmak İzi / Yüz Tanıma ile Aç
                    </Text>
                  </TouchableOpacity>
                )}
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
                <Text style={styles.unlockedText}>
                  {vaultState.ownerName
                    ? `${vaultState.ownerName} • ${vaultState.entries.length} Kayıt`
                    : `${vaultState.entries.length} Kayıt`}
                </Text>
                <Text style={styles.vaultFileName} numberOfLines={1}>
                  {vaultState.fileName}
                </Text>
              </View>

              <View style={styles.dashHeaderActions}>
                <TouchableOpacity
                  onPress={() => {
                    setChangePwSectionOpen(false);
                    setSettingsModalOpen(true);
                  }}
                  style={styles.headerActionButton}
                >
                  <Text style={styles.headerActionText}>Ayarlar</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={() => handleLock(false)}
                  style={styles.headerLockButton}
                >
                  <Text style={styles.headerLockText}>Kilitle</Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Arama Çubuğu */}
            <View style={styles.searchSection}>
              <View style={styles.searchBar}>
                <TextInput
                  style={styles.searchBarInput}
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Kayıtlarda ara..."
                  placeholderTextColor={COLORS.mutedForeground}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                {query.length > 0 && (
                  <TouchableOpacity onPress={() => setQuery('')}>
                    <Text style={styles.clearQueryText}>Temizle</Text>
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
                  return (
                    <TouchableOpacity
                      key={item.id}
                      onPress={() => setFilter(item.id)}
                      style={[
                        styles.filterPill,
                        active
                          ? styles.filterPillActive
                          : styles.filterPillInactive,
                      ]}
                    >
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
                data={visibleEntries}
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
                    <Text style={styles.emptySearchTitle}>
                      {query
                        ? `"${query}" bulunamadı`
                        : 'Kasanızda henüz kayıt yok'}
                    </Text>
                    {!query && (
                      <TouchableOpacity
                        onPress={openAddEntryModal}
                        style={styles.emptyAddBtn}
                      >
                        <Text style={styles.emptyAddBtnText}>
                          + İlk Kaydı Ekle
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
              onPress={openAddEntryModal}
              style={styles.fabButton}
            >
              <Text style={styles.fabIcon}>+</Text>
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
                    <Text style={styles.sheetTitle}>{selectedEntry.title}</Text>
                    <TouchableOpacity
                      onPress={() => setDetailModalOpen(false)}
                      style={styles.closeButton}
                    >
                      <Text style={styles.closeButtonText}>Kapat</Text>
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
                        onPress={() =>
                          handleCopyText(
                            selectedEntry.username,
                            'Kullanıcı adı'
                          )
                        }
                        style={styles.detailCopyPill}
                      >
                        <Text style={styles.detailCopyPillText}>Kopyala</Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>

                  {/* Şifre Satırı (Varsayılan Gizli + Göster/Gizle + Kopyala) */}
                  <View style={styles.detailRowBox}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.fieldLabel}>ŞİFRE</Text>
                      <Text style={styles.detailValueMono}>
                        {detailPasswordVisible
                          ? selectedEntry.password
                          : '••••••••••••'}
                      </Text>
                    </View>
                    <View style={styles.inlinePillGroup}>
                      <TouchableOpacity
                        onPress={() => setDetailPasswordVisible((v) => !v)}
                        style={styles.detailCopyPill}
                      >
                        <Text style={styles.detailCopyPillText}>
                          {detailPasswordVisible ? 'Gizle' : 'Göster'}
                        </Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        onPress={() =>
                          handleCopyText(selectedEntry.password, 'Şifre')
                        }
                        style={styles.detailCopyPill}
                      >
                        <Text style={styles.detailCopyPillText}>Kopyala</Text>
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
                          onPress={() => handleOpenUrl(selectedEntry.url!)}
                          style={styles.detailCopyPill}
                        >
                          <Text style={styles.detailCopyPillText}>Aç</Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                          onPress={() =>
                            handleCopyText(selectedEntry.url!, 'URL')
                          }
                          style={styles.detailCopyPill}
                        >
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
                      onPress={() => openEditEntryModal(selectedEntry)}
                      style={[styles.unlockButton, { flex: 1 }]}
                    >
                      <Text style={styles.unlockButtonText}>Kaydı Düzenle</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      onPress={() => handleDeleteEntry(selectedEntry)}
                      style={[
                        styles.deleteEntryButton,
                        { paddingHorizontal: 20 },
                      ]}
                    >
                      <Text style={styles.deleteEntryButtonText}>Sil</Text>
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
                    setAddModalOpen(false);
                    setEditingEntryId(null);
                  }}
                  style={styles.closeButton}
                >
                  <Text style={styles.closeButtonText}>Kapat</Text>
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
                    placeholderTextColor={COLORS.mutedForeground}
                    value={newTitle}
                    onChangeText={setNewTitle}
                  />
                </View>

                <View style={styles.modalFieldGroup}>
                  <View style={styles.fieldLabelRow}>
                    <Text style={styles.fieldLabel}>KULLANICI ADI</Text>
                    {vaultState.ownerName ? (
                      <TouchableOpacity
                        onPress={() => setNewUsername(vaultState.ownerName)}
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
                    placeholderTextColor={COLORS.mutedForeground}
                    value={newUsername}
                    onChangeText={setNewUsername}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>

                <View style={styles.modalFieldGroup}>
                  <View style={styles.fieldLabelRow}>
                    <Text style={styles.fieldLabel}>ŞİFRE *</Text>
                    <TouchableOpacity
                      onPress={() =>
                        generateStrongPassword(
                          genLength,
                          genIncludeNumbers,
                          genIncludeSymbols
                        )
                      }
                    >
                      <Text style={styles.regenerateLink}>Yeni Şifre Üret</Text>
                    </TouchableOpacity>
                  </View>
                  <TextInput
                    style={[styles.modalInputBox, { fontFamily: MONO_FONT }]}
                    placeholder="Şifre girin veya üretin"
                    placeholderTextColor={COLORS.mutedForeground}
                    value={newPassword}
                    onChangeText={setNewPassword}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />

                  {/* Özelleştirilebilir Şifre Üretici Kontrolleri */}
                  <View style={styles.generatorOptionsRow}>
                    <View style={styles.generatorLengthsGroup}>
                      {GENERATOR_LENGTHS.map((len) => {
                        const active = genLength === len;
                        return (
                          <TouchableOpacity
                            key={len}
                            onPress={() => {
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
                    placeholderTextColor={COLORS.mutedForeground}
                    value={newUrl}
                    onChangeText={setNewUrl}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>

                <View style={styles.modalFieldGroup}>
                  <Text style={styles.fieldLabel}>NOTLAR (İSTEĞE BAĞLI)</Text>
                  <TextInput
                    style={styles.modalInputBox}
                    placeholder="Ek notlar"
                    placeholderTextColor={COLORS.mutedForeground}
                    value={newNotes}
                    onChangeText={setNewNotes}
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
                        { cat: 'logins', label: 'Girişler' },
                        { cat: 'servers', label: 'Sunucular' },
                        { cat: 'tokens', label: 'Tokenlar' },
                        { cat: 'notes', label: 'Notlar' },
                      ] as const
                    ).map((item) => {
                      const active = newCategory === item.cat;
                      return (
                        <TouchableOpacity
                          key={item.cat}
                          onPress={() => setNewCategory(item.cat)}
                          style={[
                            styles.filterPill,
                            active
                              ? styles.filterPillActive
                              : styles.filterPillInactive,
                          ]}
                        >
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
                  disabled={isSaving}
                  onPress={handleSaveEntry}
                  style={styles.unlockButton}
                >
                  <Text style={styles.unlockButtonText}>
                    {isSaving
                      ? 'Kaydediliyor…'
                      : editingEntryId
                      ? 'Değişiklikleri Kaydet'
                      : 'Kaydet'}
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
                <Text style={styles.sheetTitle}>Ayarlar</Text>
                <TouchableOpacity
                  onPress={() => setSettingsModalOpen(false)}
                  style={styles.closeButton}
                >
                  <Text style={styles.closeButtonText}>Kapat</Text>
                </TouchableOpacity>
              </View>

              <ScrollView
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ gap: 14 }}
              >
                {/* Kullanıcı Adı */}
                <View style={styles.modalFieldGroup}>
                  <Text style={styles.fieldLabel}>ADINIZ</Text>
                  <View style={styles.detailActionButtons}>
                    <TextInput
                      style={[styles.modalInputBox, { flex: 1 }]}
                      value={ownerNameInput}
                      onChangeText={setOwnerNameInput}
                      placeholder="Adınız"
                      placeholderTextColor={COLORS.mutedForeground}
                    />
                    <TouchableOpacity
                      onPress={async () => {
                        const clean = ownerNameInput.trim();
                        await kdbxService.saveProfile({ ownerName: clean });
                        setVaultState((prev) => ({
                          ...prev,
                          ownerName: clean,
                        }));
                        showToast('Adınız kaydedildi');
                      }}
                      style={[
                        styles.detailCopyPill,
                        { justifyContent: 'center', paddingHorizontal: 14 },
                      ]}
                    >
                      <Text style={styles.detailCopyPillText}>Kaydet</Text>
                    </TouchableOpacity>
                  </View>
                </View>

                {/* Güvenlik Seçenekleri (Arka Planda Otomatik Kilitle & Biyometrik) */}
                <View style={styles.modalFieldGroup}>
                  <Text style={styles.fieldLabel}>GÜVENLİK</Text>

                  <TouchableOpacity
                    activeOpacity={0.8}
                    onPress={async () => {
                      const next = !autoLockOnBackground;
                      setAutoLockOnBackground(next);
                      await kdbxService.saveProfile({
                        autoLockOnBackground: next,
                      });
                      showToast(
                        next
                          ? 'Arka planda otomatik kilit açıldı'
                          : 'Arka planda otomatik kilit kapatıldı'
                      );
                    }}
                    style={styles.detailRowBox}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.settingTitleText}>
                        Arka Planda Otomatik Kilitle
                      </Text>
                      <Text style={styles.settingSubText}>
                        Uygulamadan çıkıldığında kasayı anında kilitler
                      </Text>
                    </View>
                    <View
                      style={[
                        styles.detailCopyPill,
                        autoLockOnBackground && styles.filterPillActive,
                      ]}
                    >
                      <Text
                        style={[
                          styles.detailCopyPillText,
                          autoLockOnBackground && styles.filterPillTextActive,
                        ]}
                      >
                        {autoLockOnBackground ? 'Açık' : 'Kapalı'}
                      </Text>
                    </View>
                  </TouchableOpacity>

                  {biometricSupported && (
                    <TouchableOpacity
                      activeOpacity={0.8}
                      onPress={async () => {
                        isSystemDialogOpenRef.current = true;
                        try {
                          const next = !biometricEnabledForActive;
                          const result =
                            await kdbxService.setBiometricForCurrentVault(next);
                          setBiometricEnabledForActive(result);
                          showToast(
                            result
                              ? 'Biyometrik giriş etkinleştirildi'
                              : 'Biyometrik giriş kaldırıldı'
                          );
                        } catch (err: unknown) {
                          Alert.alert(
                            'Biyometrik Giriş',
                            err instanceof Error
                              ? err.message
                              : 'İşlem tamamlanamadı.'
                          );
                        } finally {
                          setTimeout(() => {
                            isSystemDialogOpenRef.current = false;
                          }, 600);
                        }
                      }}
                      style={styles.detailRowBox}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={styles.settingTitleText}>
                          Parmak İzi / Yüz Tanıma
                        </Text>
                        <Text style={styles.settingSubText}>
                          {vaultState.fileName} için hızlı kilit açma
                        </Text>
                      </View>
                      <View
                        style={[
                          styles.detailCopyPill,
                          biometricEnabledForActive && styles.filterPillActive,
                        ]}
                      >
                        <Text
                          style={[
                            styles.detailCopyPillText,
                            biometricEnabledForActive &&
                              styles.filterPillTextActive,
                          ]}
                        >
                          {biometricEnabledForActive ? 'Açık' : 'Kapalı'}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  )}
                </View>

                {/* Kasa Ana Şifresini Değiştirme Bölümü */}
                <View style={styles.modalFieldGroup}>
                  <TouchableOpacity
                    onPress={() => setChangePwSectionOpen((v) => !v)}
                    style={styles.secondaryOutlineButton}
                  >
                    <Text style={styles.secondaryOutlineText}>
                      {changePwSectionOpen
                        ? 'Ana Şifre Değiştirmeyi Kapat'
                        : 'Kasa Ana Şifresini Değiştir'}
                    </Text>
                  </TouchableOpacity>

                  {changePwSectionOpen && (
                    <View style={styles.changePwBox}>
                      <TextInput
                        style={styles.modalInputBox}
                        placeholder="Mevcut ana şifreniz"
                        placeholderTextColor={COLORS.mutedForeground}
                        secureTextEntry
                        value={currentMasterPwInput}
                        onChangeText={setCurrentMasterPwInput}
                        autoCapitalize="none"
                      />
                      <TextInput
                        style={styles.modalInputBox}
                        placeholder="Yeni ana şifre"
                        placeholderTextColor={COLORS.mutedForeground}
                        secureTextEntry
                        value={newMasterPwInput}
                        onChangeText={setNewMasterPwInput}
                        autoCapitalize="none"
                      />
                      <TextInput
                        style={styles.modalInputBox}
                        placeholder="Yeni ana şifre tekrarı"
                        placeholderTextColor={COLORS.mutedForeground}
                        secureTextEntry
                        value={confirmNewMasterPwInput}
                        onChangeText={setConfirmNewMasterPwInput}
                        autoCapitalize="none"
                      />
                      <TouchableOpacity
                        onPress={handleChangeMasterPassword}
                        style={styles.unlockButton}
                      >
                        <Text style={styles.unlockButtonText}>
                          Yeni Ana Şifreyi Kaydet
                        </Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </View>

                {/* Cihazdaki Kayıtlı Kasalar ve Silme */}
                <View style={styles.modalFieldGroup}>
                  <Text style={styles.fieldLabel}>CİHAZDAKİ KASALAR</Text>
                  {Array.from(
                    new Set([vaultState.fileName, ...knownVaults])
                  ).map((vaultFile) => {
                    const isCurrent = vaultFile === vaultState.fileName;
                    return (
                      <View key={vaultFile} style={styles.detailRowBox}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.settingTitleText}>
                            {vaultFile} {isCurrent ? '(Aktif)' : ''}
                          </Text>
                        </View>
                        <View style={styles.inlinePillGroup}>
                          {!isCurrent && (
                            <TouchableOpacity
                              onPress={async () => {
                                setSettingsModalOpen(false);
                                handleLock(true);
                                await handleSelectKnownVault(vaultFile);
                                setAuthMode('unlock');
                              }}
                              style={styles.detailCopyPill}
                            >
                              <Text style={styles.detailCopyPillText}>Geç</Text>
                            </TouchableOpacity>
                          )}
                          <TouchableOpacity
                            onPress={() => handleDeleteVaultFile(vaultFile)}
                            style={[
                              styles.detailCopyPill,
                              { borderColor: 'rgba(255, 77, 109, 0.4)' },
                            ]}
                          >
                            <Text
                              style={[
                                styles.detailCopyPillText,
                                { color: COLORS.dangerRed },
                              ]}
                            >
                              Sil
                            </Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    );
                  })}
                </View>

                {/* Dışa ve İçe Aktarma */}
                <TouchableOpacity
                  onPress={async () => {
                    isSystemDialogOpenRef.current = true;
                    try {
                      await kdbxService.exportCurrentVault();
                    } catch (err: unknown) {
                      Alert.alert(
                        'Dışa Aktar',
                        err instanceof Error
                          ? err.message
                          : 'Kasa dışa aktarılamadı.'
                      );
                    } finally {
                      setTimeout(() => {
                        isSystemDialogOpenRef.current = false;
                      }, 600);
                    }
                  }}
                  style={styles.unlockButton}
                >
                  <Text style={styles.unlockButtonText}>
                    .kdbx Dosyasını Dışa Aktar / Paylaş
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={async () => {
                    setSettingsModalOpen(false);
                    handleLock(true);
                    await handleImportKdbxFile();
                  }}
                  style={styles.secondaryOutlineButton}
                >
                  <Text style={styles.secondaryOutlineText}>
                    Cihazdan Başka .kdbx Dosyası Yükle
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={() => {
                    setSettingsModalOpen(false);
                    handleLock(false);
                    setAuthMode('welcome');
                  }}
                  style={styles.deleteEntryButton}
                >
                  <Text style={styles.deleteEntryButtonText}>
                    Kasayı Kilitle ve Başlangıca Dön
                  </Text>
                </TouchableOpacity>
              </ScrollView>
            </View>
          </KeyboardAvoidingView>
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
    backgroundColor: COLORS.card,
    borderColor: COLORS.primary,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  toastText: {
    color: COLORS.primary,
    fontSize: 13,
    fontWeight: '600',
  },

  // --- BAŞLANGIÇ & GİRİŞ EKRANI ---
  lockScrollContent: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: 32,
  },
  modeSwitchBar: {
    flexDirection: 'row',
    backgroundColor: COLORS.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 4,
    gap: 4,
  },
  modeSwitchTab: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeSwitchTabActive: {
    backgroundColor: COLORS.primary,
  },
  modeSwitchTabText: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.mutedForeground,
  },
  modeSwitchTabTextActive: {
    color: COLORS.primaryForeground,
  },
  lockHero: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingVertical: 26,
  },
  lockCircleInner: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lockIconShackle: {
    width: 14,
    height: 10,
    borderTopLeftRadius: 7,
    borderTopRightRadius: 7,
    borderWidth: 2,
    borderBottomWidth: 0,
    borderColor: COLORS.primary,
    marginBottom: -1,
  },
  lockIconBody: {
    width: 22,
    height: 17,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lockIconKeyholeDot: {
    width: 3,
    height: 5,
    borderRadius: 2,
    backgroundColor: COLORS.primary,
  },
  lockBrandTitle: {
    fontFamily: MONO_FONT,
    fontSize: 24,
    fontWeight: '700',
    letterSpacing: 1,
    color: COLORS.foreground,
  },
  welcomeCard: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
    padding: 16,
    gap: 10,
  },
  ownerInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  ownerAvatarBox: {
    width: 44,
    height: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ownerAvatarText: {
    fontFamily: MONO_FONT,
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.primary,
  },
  ownerTextInput: {
    flex: 1,
    height: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.background,
    paddingHorizontal: 14,
    fontSize: 15,
    color: COLORS.foreground,
  },
  secondaryCardButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  secondaryCardTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.foreground,
  },
  secondaryCardSub: {
    fontSize: 12,
    color: COLORS.mutedForeground,
    marginTop: 2,
  },
  secondaryCardArrow: {
    fontSize: 22,
    color: COLORS.mutedForeground,
  },
  biometricUnlockButton: {
    height: 48,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(242, 242, 242, 0.45)',
    backgroundColor: COLORS.surface,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  biometricUnlockText: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.primary,
  },
  importDeviceFullButton: {
    height: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  importDeviceFullText: {
    fontSize: 13,
    fontWeight: '500',
    color: COLORS.mutedForeground,
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
    backgroundColor: COLORS.primary,
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
    paddingTop: 14,
    paddingBottom: 14,
  },
  dashHeaderLeft: {
    flex: 1,
    gap: 2,
    marginRight: 12,
  },
  unlockedText: {
    fontSize: 12,
    color: COLORS.mutedForeground,
  },
  vaultFileName: {
    fontFamily: MONO_FONT,
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.foreground,
  },
  dashHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerActionButton: {
    height: 36,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerActionText: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.foreground,
  },
  headerLockButton: {
    height: 36,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 77, 109, 0.35)',
    backgroundColor: 'rgba(255, 77, 109, 0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerLockText: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.dangerRed,
  },
  searchSection: {
    paddingHorizontal: 20,
  },
  searchBar: {
    height: 42,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
    paddingHorizontal: 14,
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
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 6,
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
    color: COLORS.primaryForeground,
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

  // --- KAYIT KARTI ---
  entryCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
    padding: 12,
  },
  monogramBox: {
    width: 42,
    height: 42,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  monogramText: {
    fontFamily: MONO_FONT,
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.foreground,
  },
  entryCenter: {
    flex: 1,
    gap: 2,
  },
  entryTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.foreground,
  },
  entryUsername: {
    fontSize: 12,
    color: COLORS.mutedForeground,
  },
  secretToggleWrap: {
    paddingTop: 2,
  },
  entrySecretMask: {
    fontFamily: MONO_FONT,
    fontSize: 12,
    color: COLORS.mutedForeground,
  },
  copyButton: {
    height: 36,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  copyButtonActive: {
    borderColor: COLORS.primary,
    backgroundColor: COLORS.primary,
  },
  copyButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.foreground,
  },
  copyButtonTextActive: {
    color: COLORS.primaryForeground,
  },
  emptySearchBox: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
    padding: 28,
    alignItems: 'center',
    gap: 12,
    marginTop: 8,
  },
  emptySearchTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.mutedForeground,
  },
  emptyAddBtn: {
    borderRadius: 8,
    backgroundColor: COLORS.primary,
    paddingHorizontal: 16,
    paddingVertical: 10,
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
    elevation: 5,
  },
  fabIcon: {
    fontSize: 28,
    color: COLORS.primaryForeground,
    lineHeight: 30,
  },

  // --- MODALLAR ---
  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.78)',
    justifyContent: 'flex-end',
  },
  sheetCard: {
    maxHeight: '90%',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderTopWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
    paddingHorizontal: 22,
    paddingTop: 12,
    paddingBottom: 30,
    gap: 14,
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: COLORS.border,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sheetTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.foreground,
  },
  closeButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
  },
  closeButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.mutedForeground,
  },
  detailRowBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.background,
    padding: 12,
  },
  detailValueMono: {
    fontFamily: MONO_FONT,
    fontSize: 13,
    color: COLORS.foreground,
    marginTop: 4,
  },
  inlinePillGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  detailCopyPill: {
    borderRadius: 6,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  detailCopyPillText: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.primary,
  },
  detailActionButtons: {
    flexDirection: 'row',
    gap: 10,
  },
  secondaryOutlineButton: {
    height: 46,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
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
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255, 77, 109, 0.4)',
    backgroundColor: 'rgba(255, 77, 109, 0.08)',
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
    height: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.background,
    paddingHorizontal: 14,
    fontSize: 14,
    color: COLORS.foreground,
  },
  regenerateLink: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.primary,
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
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.background,
  },
  genOptionPillActive: {
    borderColor: COLORS.primary,
    backgroundColor: COLORS.primary,
  },
  genOptionPillText: {
    fontFamily: MONO_FONT,
    fontSize: 11,
    fontWeight: '600',
    color: COLORS.mutedForeground,
  },
  genOptionPillTextActive: {
    color: COLORS.primaryForeground,
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
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.background,
    marginTop: 4,
  },
});
