import { fontWeights } from '@/constants/Fonts';
import { supabase } from '@/constants/SupabaseConfig';
import { useTheme } from '@/hooks/useThemeColor';
import React, { useState } from 'react';
import {
    Alert,
    KeyboardAvoidingView,
    Linking,
    Modal,
    Platform,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View
} from 'react-native';
import { Card } from './ui/Card';

interface AuthOverlayProps {
    visible: boolean;
    onClose: () => void;
}

export const AuthOverlay: React.FC<AuthOverlayProps> = ({ visible, onClose }) => {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [mode, setMode] = useState<'signin' | 'signup' | 'forgot'>('signin');
    const [showSuccess, setShowSuccess] = useState(false);
    const [successEmail, setSuccessEmail] = useState('');

    const theme = useTheme();

    const styles = StyleSheet.create({
        overlay: {
            flex: 1,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            justifyContent: 'center',
            alignItems: 'center',
            padding: 20,
        },
        title: {
            fontSize: 22,
            fontFamily: fontWeights[600],
            color: theme.foreground,
            textAlign: 'center',
            marginBottom: 16,
        },
        input: {
            borderWidth: 1,
            borderColor: theme.border,
            borderRadius: 12,
            padding: 12,
            height: 48,
            marginBottom: 0,
            fontSize: 16,
            color: theme.foreground,
            backgroundColor: theme.background,
        },
        button: {
            backgroundColor: theme.primary,
            borderRadius: 12,
            height: 48,
            alignItems: 'center',
            justifyContent: 'center',
            marginTop: 8,
            marginBottom: 16,
        },
        buttonDisabled: {
            opacity: 0.6,
        },
        buttonText: {
            color: theme.background,
            fontSize: 16,
            fontFamily: fontWeights[600],
        },
        switchButton: {
            alignItems: 'center',
            padding: 6,
        },
        switchText: {
            color: theme.primary,
            fontSize: 14,
            fontFamily: fontWeights[500],
        },
        closeButton: {
            position: 'absolute',
            top: 12,
            right: 12,
            padding: 6,
            zIndex: 1,
        },
        closeText: {
            color: theme.mutedForeground,
            fontSize: 18,
            fontFamily: fontWeights[500],
        },
        successContainer: {
            alignItems: 'center',
        },
        successIcon: {
            width: 64,
            height: 64,
            borderRadius: 32,
            backgroundColor: '#10B981',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 16,
        },
        successIconText: {
            fontSize: 28,
            color: '#ffffff',
        },
        successTitle: {
            fontSize: 24,
            fontFamily: fontWeights[600],
            color: theme.foreground,
            textAlign: 'center',
            marginBottom: 8,
        },
        successDescription: {
            fontSize: 15,
            color: theme.mutedForeground,
            textAlign: 'center',
            marginBottom: 6,
            lineHeight: 20,
        },
        successEmail: {
            fontSize: 15,
            fontFamily: fontWeights[600],
            color: theme.foreground,
            textAlign: 'center',
            marginBottom: 16,
        },
        successNote: {
            backgroundColor: '#10B98120',
            borderColor: '#10B98140',
            borderWidth: 1,
            borderRadius: 8,
            padding: 12,
            marginBottom: 20,
        },
        successNoteText: {
            fontSize: 13,
            color: '#059669',
            textAlign: 'center',
            lineHeight: 18,
        },
        successButtonContainer: {
            width: '100%',
            gap: 8,
        },
        legalText: {
            fontSize: 11,
            color: theme.mutedForeground,
            textAlign: 'center',
            marginTop: 12,
            lineHeight: 14,
            paddingHorizontal: 4,
        },
        legalLink: {
            color: theme.primary,
        },
    });

    const handleAuth = async () => {
        if (!email.trim()) {
            Alert.alert('Error', 'Please enter your email');
            return;
        }

        if (mode !== 'forgot' && !password.trim()) {
            Alert.alert('Error', 'Please enter your password');
            return;
        }

        setLoading(true);

        try {
            if (mode === 'signup') {
                if (password !== confirmPassword) {
                    Alert.alert('Error', 'Passwords do not match');
                    return;
                }
                if (password.length < 6) {
                    Alert.alert('Error', 'Password must be at least 6 characters');
                    return;
                }

                const { error } = await supabase.auth.signUp({
                    email: email.trim(),
                    password: password.trim(),
                });

                if (error) {
                    Alert.alert('Sign Up Error', error.message);
                } else {
                    setSuccessEmail(email.trim());
                    setShowSuccess(true);
                }
            } else if (mode === 'forgot') {
                const { error } = await supabase.auth.resetPasswordForEmail(email.trim());

                if (error) {
                    Alert.alert('Error', error.message);
                } else {
                    Alert.alert('Success', 'Check your email for a password reset link');
                    setMode('signin');
                }
            } else {
                const { error } = await supabase.auth.signInWithPassword({
                    email: email.trim(),
                    password: password.trim(),
                });

                if (error) {
                    if (error.message === 'Email not confirmed') {
                        Alert.alert(
                            'Email Not Confirmed',
                            'Please check your email and click the confirmation link before signing in.',
                            [
                                { text: 'Cancel', style: 'cancel' },
                                {
                                    text: 'Resend Email',
                                    onPress: async () => {
                                        const { error: resendError } = await supabase.auth.resend({
                                            type: 'signup',
                                            email: email.trim()
                                        });

                                        if (resendError) {
                                            Alert.alert('Error', resendError.message);
                                        } else {
                                            Alert.alert('Success', 'Confirmation email sent! Please check your inbox.');
                                        }
                                    }
                                }
                            ]
                        );
                    } else {
                        Alert.alert('Sign In Error', error.message);
                    }
                } else {
                    onClose();
                }
            }
        } catch (error) {
            Alert.alert('Error', 'An unexpected error occurred');
        } finally {
            setLoading(false);
        }
    };

    const resetForm = () => {
        setEmail('');
        setPassword('');
        setConfirmPassword('');
        setMode('signin');
        setShowSuccess(false);
        setSuccessEmail('');
    };

    const handleClose = () => {
        resetForm();
        onClose();
    };

    const handleBackToSignIn = () => {
        setShowSuccess(false);
        setSuccessEmail('');
        setMode('signin');
        setEmail('');
        setPassword('');
        setConfirmPassword('');
    };

    return (
        <Modal visible={visible} transparent animationType="fade">
            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                style={styles.overlay}
            >
                <Card
                    style={{
                        width: '100%',
                        maxWidth: 400,
                        position: 'relative',
                        padding: 16,
                        gap: 16,
                    }}
                    bordered
                    elevated
                >
                    <TouchableOpacity style={styles.closeButton} onPress={handleClose}>
                        <Text style={styles.closeText}>✕</Text>
                    </TouchableOpacity>

                    {showSuccess ? (
                        <View style={styles.successContainer}>
                            <View style={styles.successIcon}>
                                <Text style={styles.successIconText}>✉</Text>
                            </View>

                            <Text style={styles.successTitle}>Check your email</Text>

                            <Text style={styles.successDescription}>
                                We've sent a confirmation link to:
                            </Text>

                            <Text style={styles.successEmail}>{successEmail}</Text>

                            <View style={styles.successNote}>
                                <Text style={styles.successNoteText}>
                                    Click the link in the email to activate your account. If you don't see the email, check your spam folder.
                                </Text>
                            </View>

                            <View style={styles.successButtonContainer}>
                                <TouchableOpacity style={styles.button} onPress={handleBackToSignIn}>
                                    <Text style={styles.buttonText}>Back to Sign In</Text>
                                </TouchableOpacity>

                                <TouchableOpacity
                                    style={[styles.button, { backgroundColor: 'transparent', borderWidth: 1, borderColor: theme.primary }]}
                                    onPress={handleClose}
                                >
                                    <Text style={[styles.buttonText, { color: theme.primary }]}>Close</Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                    ) : (
                        <>
                            <Text style={styles.title}>
                                {mode === 'signup' ? 'Create Account' : mode === 'forgot' ? 'Reset Password' : 'Sign In'}
                            </Text>

                            <TextInput
                                style={styles.input}
                                placeholder="Email"
                                placeholderTextColor={theme.mutedForeground}
                                value={email}
                                onChangeText={setEmail}
                                keyboardType="email-address"
                                autoCapitalize="none"
                                autoCorrect={false}
                            />

                            {mode !== 'forgot' && (
                                <TextInput
                                    style={styles.input}
                                    placeholder="Password"
                                    placeholderTextColor={theme.mutedForeground}
                                    value={password}
                                    onChangeText={setPassword}
                                    secureTextEntry
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                />
                            )}

                            {mode === 'signup' && (
                                <TextInput
                                    style={styles.input}
                                    placeholder="Confirm Password"
                                    placeholderTextColor={theme.mutedForeground}
                                    value={confirmPassword}
                                    onChangeText={setConfirmPassword}
                                    secureTextEntry
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                />
                            )}

                            <TouchableOpacity
                                style={[styles.button, loading && styles.buttonDisabled]}
                                onPress={handleAuth}
                                disabled={loading}
                            >
                                <Text style={styles.buttonText}>
                                    {loading ? 'Loading...' : mode === 'signup' ? 'Sign Up' : mode === 'forgot' ? 'Send Reset Link' : 'Sign In'}
                                </Text>
                            </TouchableOpacity>

                            {mode === 'signin' && (
                                <TouchableOpacity
                                    style={styles.switchButton}
                                    onPress={() => setMode('forgot')}
                                >
                                    <Text style={styles.switchText}>Forgot Password?</Text>
                                </TouchableOpacity>
                            )}

                            <TouchableOpacity
                                style={styles.switchButton}
                                onPress={() => setMode(mode === 'signup' ? 'signin' : 'signup')}
                            >
                                <Text style={styles.switchText}>
                                    {mode === 'signup'
                                        ? 'Already have an account? Sign In'
                                        : mode === 'forgot'
                                            ? 'Back to Sign In'
                                            : 'Need an account? Sign Up'}
                                </Text>
                            </TouchableOpacity>

                            <View>
                                <Text style={styles.legalText}>
                                    By continuing, you agree to our{' '}
                                    <Text
                                        style={styles.legalLink}
                                        onPress={() => Linking.openURL('https://www.suna.so/legal?tab=terms')}
                                    >
                                        Terms of Service
                                    </Text>
                                    {' '}and{' '}
                                    <Text
                                        style={styles.legalLink}
                                        onPress={() => Linking.openURL('https://www.suna.so/legal?tab=privacy')}
                                    >
                                        Privacy Policy
                                    </Text>
                                </Text>
                            </View>
                        </>
                    )}
                </Card>
            </KeyboardAvoidingView>
        </Modal>
    );
}; 