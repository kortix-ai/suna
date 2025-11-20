import * as React from 'react';
import { View, TextInput, TouchableOpacity, Platform } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Eye, EyeOff, Check } from 'lucide-react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import Svg, { Path } from 'react-native-svg';
import { useColorScheme } from 'nativewind';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring,
  FadeIn,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { useLanguage } from '@/contexts';

const AnimatedPressable = Animated.createAnimatedComponent(TouchableOpacity);
const AnimatedView = Animated.createAnimatedComponent(View);

interface SignInFormProps {
  email: string;
  setEmail: (email: string) => void;
  password: string;
  setPassword: (password: string) => void;
  showPassword: boolean;
  setShowPassword: (show: boolean) => void;
  error: string;
  isLoading: boolean;
  onSubmit: () => void;
  onOAuthSignIn?: (provider: 'apple' | 'google') => void;
  emailInputRef?: React.RefObject<TextInput | null>;
  passwordInputRef?: React.RefObject<TextInput | null>;
  hideOAuth?: boolean;
}

export function SignInForm({
  email,
  setEmail,
  password,
  setPassword,
  showPassword,
  setShowPassword,
  error,
  isLoading,
  onSubmit,
  onOAuthSignIn,
  emailInputRef,
  passwordInputRef,
  hideOAuth = false,
}: SignInFormProps) {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const buttonScale = useSharedValue(1);

  const buttonAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: buttonScale.value }],
  }));

  const isDark = colorScheme === 'dark';
  const canSubmit = email.length > 0 && password.length > 0 && !isLoading;

  return (
    <View className="gap-4">
      {!hideOAuth && onOAuthSignIn && (
        <>
          <View className="gap-3 mb-2">
            <AppleSignInButton
              onPress={() => onOAuthSignIn('apple')}
              label={t('auth.continueWithApple')}
            />
            <GoogleSignInButton
              onPress={() => onOAuthSignIn('google')}
              label={t('auth.continueWithGoogle')}
            />
          </View>

          <View className="flex-row items-center mb-2">
            <View className="flex-1 h-px bg-border" />
            <Text className="text-muted-foreground text-[14px] font-roobert mx-4">{t('auth.or')}</Text>
            <View className="flex-1 h-px bg-border" />
          </View>
        </>
      )}

      <View className="gap-4">
        <View className="bg-muted/10 dark:bg-muted/30 rounded-[20px] h-14 px-5 justify-center">
          <TextInput
            ref={emailInputRef}
            value={email}
            onChangeText={(text) => setEmail(text.trim().toLowerCase())}
            placeholder={t('auth.emailPlaceholder')}
            placeholderTextColor="hsl(var(--muted-foreground))"
            keyboardType="email-address"
            textContentType="emailAddress"
            autoComplete="email"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="next"
            onSubmitEditing={() => passwordInputRef?.current?.focus()}
            style={{ fontFamily: 'Roobert-Regular', fontSize: 16 }}
            className="text-foreground"
          />
        </View>

        <View className="bg-muted/10 dark:bg-muted/30 rounded-[20px] h-14 px-5 flex-row items-center">
          <TextInput
            ref={passwordInputRef}
            value={password}
            onChangeText={setPassword}
            placeholder={t('auth.passwordPlaceholder')}
            placeholderTextColor="hsl(var(--muted-foreground))"
            secureTextEntry={!showPassword}
            textContentType="password"
            autoComplete="password"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="go"
            onSubmitEditing={canSubmit ? onSubmit : undefined}
            style={{ fontFamily: 'Roobert-Regular', fontSize: 16 }}
            className="flex-1 text-foreground"
          />
          <TouchableOpacity
            onPress={() => {
              setShowPassword(!showPassword);
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Icon
              as={showPassword ? EyeOff : Eye}
              size={20}
              className="text-muted-foreground"
            />
          </TouchableOpacity>
        </View>
      </View>

      {error && (
        <AnimatedView entering={FadeIn.duration(200)} className="mt-2">
          <Text className="text-destructive text-[14px] font-roobert text-center">
            {error}
          </Text>
        </AnimatedView>
      )}

      <AnimatedPressable
        onPress={canSubmit ? onSubmit : undefined}
        disabled={!canSubmit}
        onPressIn={() => {
          if (canSubmit) {
            buttonScale.value = withSpring(0.96, { damping: 15, stiffness: 400 });
          }
        }}
        onPressOut={() => {
          buttonScale.value = withSpring(1, { damping: 15, stiffness: 400 });
        }}
        style={[buttonAnimatedStyle, { 
          backgroundColor: canSubmit ? (isDark ? '#FFFFFF' : '#000000') : '#888888',
          height: 56,
          borderRadius: 28,
          justifyContent: 'center',
          alignItems: 'center',
          opacity: canSubmit ? 1 : 0.5,
          marginTop: 8,
        }]}
      >
        {isLoading ? (
          <KortixLoader size="small" forceTheme={isDark ? 'light' : 'dark'} />
        ) : (
          <Text style={{ 
            color: isDark ? '#000000' : '#FFFFFF',
            fontSize: 16,
            fontFamily: 'Roobert-Medium',
          }}>
            {t('auth.logIn')}
          </Text>
        )}
      </AnimatedPressable>
    </View>
  );
}

interface SignUpFormProps {
  email: string;
  setEmail: (email: string) => void;
  password: string;
  setPassword: (password: string) => void;
  confirmPassword: string;
  setConfirmPassword: (password: string) => void;
  showPassword: boolean;
  setShowPassword: (show: boolean) => void;
  showConfirmPassword: boolean;
  setShowConfirmPassword: (show: boolean) => void;
  error: string;
  isLoading: boolean;
  onSubmit: () => void;
  onOAuthSignIn?: (provider: 'apple' | 'google') => void;
  emailInputRef?: React.RefObject<TextInput | null>;
  passwordInputRef?: React.RefObject<TextInput | null>;
  confirmPasswordInputRef?: React.RefObject<TextInput | null>;
  hideOAuth?: boolean;
}

export function SignUpForm({
  email,
  setEmail,
  password,
  setPassword,
  confirmPassword,
  setConfirmPassword,
  showPassword,
  setShowPassword,
  showConfirmPassword,
  setShowConfirmPassword,
  error,
  isLoading,
  onSubmit,
  onOAuthSignIn,
  emailInputRef,
  passwordInputRef,
  confirmPasswordInputRef,
  hideOAuth = false,
}: SignUpFormProps) {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const buttonScale = useSharedValue(1);

  const buttonAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: buttonScale.value }],
  }));

  const isDark = colorScheme === 'dark';
  const passwordsMatch = password === confirmPassword || confirmPassword.length === 0;
  const canSubmit = 
    email.length > 0 && 
    password.length >= 8 && 
    confirmPassword.length > 0 && 
    passwordsMatch && 
    !isLoading;

  return (
    <View className="gap-4">
      {!hideOAuth && onOAuthSignIn && (
        <>
          <View className="gap-3 mb-2">
            <AppleSignInButton
              onPress={() => onOAuthSignIn('apple')}
              label={t('auth.continueWithApple')}
            />
            <GoogleSignInButton
              onPress={() => onOAuthSignIn('google')}
              label={t('auth.continueWithGoogle')}
            />
          </View>

          <View className="flex-row items-center mb-2">
            <View className="flex-1 h-px bg-border" />
            <Text className="text-muted-foreground text-[14px] font-roobert mx-4">{t('auth.or')}</Text>
            <View className="flex-1 h-px bg-border" />
          </View>
        </>
      )}

      <View className="gap-4">
        <View className="bg-muted/10 dark:bg-muted/30 rounded-[20px] h-14 px-5 justify-center">
          <TextInput
            ref={emailInputRef}
            value={email}
            onChangeText={(text) => setEmail(text.trim().toLowerCase())}
            placeholder={t('auth.emailPlaceholder')}
            placeholderTextColor="hsl(var(--muted-foreground))"
            keyboardType="email-address"
            textContentType="emailAddress"
            autoComplete="email"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="next"
            onSubmitEditing={() => passwordInputRef?.current?.focus()}
            style={{ fontFamily: 'Roobert-Regular', fontSize: 16 }}
            className="text-foreground"
          />
        </View>

        <View className="bg-muted/10 dark:bg-muted/30 rounded-[20px] h-14 px-5 flex-row items-center">
          <TextInput
            ref={passwordInputRef}
            value={password}
            onChangeText={setPassword}
            placeholder={t('auth.passwordPlaceholder')}
            placeholderTextColor="hsl(var(--muted-foreground))"
            secureTextEntry={!showPassword}
            textContentType="newPassword"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="next"
            onSubmitEditing={() => confirmPasswordInputRef?.current?.focus()}
            style={{ fontFamily: 'Roobert-Regular', fontSize: 16 }}
            className="flex-1 text-foreground"
          />
          <TouchableOpacity
            onPress={() => {
              setShowPassword(!showPassword);
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Icon
              as={showPassword ? EyeOff : Eye}
              size={20}
              className="text-muted-foreground"
            />
          </TouchableOpacity>
        </View>

        <View className="bg-muted/10 dark:bg-muted/30 rounded-[20px] h-14 px-5 flex-row items-center">
          <TextInput
            ref={confirmPasswordInputRef}
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            placeholder={t('auth.confirmPasswordPlaceholder')}
            placeholderTextColor="hsl(var(--muted-foreground))"
            secureTextEntry={!showConfirmPassword}
            textContentType="newPassword"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="go"
            onSubmitEditing={canSubmit ? onSubmit : undefined}
            style={{ fontFamily: 'Roobert-Regular', fontSize: 16 }}
            className="flex-1 text-foreground"
          />
          <TouchableOpacity
            onPress={() => {
              setShowConfirmPassword(!showConfirmPassword);
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Icon
              as={showConfirmPassword ? EyeOff : Eye}
              size={20}
              className="text-muted-foreground"
            />
          </TouchableOpacity>
        </View>
      </View>

      {!passwordsMatch && confirmPassword.length > 0 && (
        <AnimatedView entering={FadeIn.duration(200)} className="mt-2">
          <Text className="text-destructive text-[14px] font-roobert text-center">
            {t('auth.passwordsDontMatch')}
          </Text>
        </AnimatedView>
      )}

      {error && (
        <AnimatedView entering={FadeIn.duration(200)} className="mt-2">
          <Text className="text-destructive text-[14px] font-roobert text-center">
            {error}
          </Text>
        </AnimatedView>
      )}

      <AnimatedPressable
        onPress={canSubmit ? onSubmit : undefined}
        disabled={!canSubmit}
        onPressIn={() => {
          if (canSubmit) {
            buttonScale.value = withSpring(0.96, { damping: 15, stiffness: 400 });
          }
        }}
        onPressOut={() => {
          buttonScale.value = withSpring(1, { damping: 15, stiffness: 400 });
        }}
        style={[buttonAnimatedStyle, { 
          backgroundColor: canSubmit ? (isDark ? '#FFFFFF' : '#000000') : '#888888',
          height: 56,
          borderRadius: 28,
          justifyContent: 'center',
          alignItems: 'center',
          opacity: canSubmit ? 1 : 0.5,
          marginTop: 8,
        }]}
      >
        {isLoading ? (
          <KortixLoader size="small" forceTheme={isDark ? 'light' : 'dark'} />
        ) : (
          <Text style={{ 
            color: isDark ? '#000000' : '#FFFFFF',
            fontSize: 16,
            fontFamily: 'Roobert-Medium',
          }}>
            {t('auth.signUp')}
          </Text>
        )}
      </AnimatedPressable>
    </View>
  );
}

function AppleSignInButton({ onPress, label }: { onPress: () => void; label: string }) {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={() => {
        scale.value = withSpring(0.98, { damping: 15, stiffness: 400 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, { damping: 15, stiffness: 400 });
      }}
      style={animatedStyle}
      className="h-12 rounded-2xl bg-[#000000] flex-row items-center justify-center gap-2"
    >
      <FontAwesome5 name="apple" size={20} color="white" />
      <Text className="text-[15px] font-roobert-medium text-white">
        {label}
      </Text>
    </AnimatedPressable>
  );
}

function GoogleSignInButton({ onPress, label }: { onPress: () => void; label: string }) {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={() => {
        scale.value = withSpring(0.98, { damping: 15, stiffness: 400 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, { damping: 15, stiffness: 400 });
      }}
      style={animatedStyle}
      className="h-12 rounded-2xl bg-white border border-[#dadce0] flex-row items-center justify-center gap-2"
    >
      <GoogleLogo />
      <Text className="text-[15px] font-roobert-medium text-[#1f1f1f]">
        {label}
      </Text>
    </AnimatedPressable>
  );
}

function GoogleLogo() {
  return (
    <Svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <Path
        d="M19.6 10.227c0-.709-.064-1.39-.182-2.045H10v3.868h5.382a4.6 4.6 0 01-1.996 3.018v2.51h3.232c1.891-1.742 2.982-4.305 2.982-7.35z"
        fill="#4285F4"
      />
      <Path
        d="M10 20c2.7 0 4.964-.895 6.618-2.423l-3.232-2.509c-.895.6-2.04.955-3.386.955-2.605 0-4.81-1.76-5.595-4.123H1.064v2.59A9.996 9.996 0 0010 20z"
        fill="#34A853"
      />
      <Path
        d="M4.405 11.9c-.2-.6-.314-1.24-.314-1.9 0-.66.114-1.3.314-1.9V5.51H1.064A9.996 9.996 0 000 10c0 1.614.386 3.14 1.064 4.49l3.34-2.59z"
        fill="#FBBC05"
      />
      <Path
        d="M10 3.977c1.468 0 2.786.505 3.823 1.496l2.868-2.868C14.96.99 12.695 0 10 0 6.09 0 2.71 2.24 1.064 5.51l3.34 2.59C5.19 5.736 7.395 3.977 10 3.977z"
        fill="#EA4335"
      />
    </Svg>
  );
}

