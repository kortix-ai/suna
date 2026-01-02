# Android Device Connection Troubleshooting

## Device Not Detected by ADB

If `adb devices` shows no devices, follow these steps:

### 1. Enable USB Debugging on Your Phone

1. **Enable Developer Options:**
   - Go to **Settings** → **About Phone**
   - Find **Build Number** (might be under "Software Information" or "About Device")
   - Tap **Build Number 7 times** until you see "You are now a developer!"

2. **Enable USB Debugging:**
   - Go to **Settings** → **Developer Options** (or **System** → **Developer Options**)
   - Toggle **USB Debugging** ON
   - If you see "Allow USB debugging?" prompt, check "Always allow from this computer" and tap **OK**

### 2. Change USB Connection Mode

On your Android phone:
- When you connect via USB, you'll see a notification about USB connection
- Tap it and select **File Transfer** or **MTP** mode (NOT "Charging only")
- Some phones: Settings → Connected devices → USB → Select "File Transfer"

### 3. Authorize Computer

- When you first connect, your phone should show a popup: **"Allow USB debugging?"**
- Check **"Always allow from this computer"**
- Tap **OK** or **Allow**

### 4. Try Different USB Cable/Port

- Some USB cables are "charge-only" - try a different cable
- Try a different USB port on your Mac
- Avoid USB hubs - connect directly to Mac

### 5. Restart ADB

```bash
export ANDROID_HOME=~/Library/Android/sdk
export PATH=$PATH:$ANDROID_HOME/platform-tools
adb kill-server
adb start-server
adb devices
```

### 6. Check Phone Manufacturer Specific Steps

**Samsung:**
- May need to enable "USB debugging (Security settings)" in Developer Options
- Install Samsung USB drivers if needed

**OnePlus/Oppo:**
- Enable "Disable permission monitoring" in Developer Options

**Xiaomi:**
- Enable "USB debugging (Security settings)"
- Enable "Install via USB" in Developer Options

**Huawei:**
- May need HiSuite installed

### 7. Verify Device is Connected

Run this to see if Mac detects the device:
```bash
system_profiler SPUSBDataType | grep -i "android\|samsung\|google"
```

### 8. Test Connection

After following above steps:
```bash
cd /Users/faiz/Developer/GitHub/suna/apps/mobile
export ANDROID_HOME=~/Library/Android/sdk
export PATH=$PATH:$ANDROID_HOME/platform-tools
adb devices
```

You should see something like:
```
List of devices attached
ABC123XYZ    device
```

If you see `unauthorized`, tap "Allow" on your phone.

