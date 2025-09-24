# 🔧 Kusor Network & Connectivity Troubleshooting

## 🚨 Current Issues

### **Supabase Connectivity Problem**
- **Error**: `getaddrinfo ENOTFOUND bzimzrdxrbdhvovahhtc.supabase.co`
- **Cause**: Network connectivity or DNS resolution issue
- **Impact**: Frontend authentication not working

### **Port Conflict**
- **Error**: `[Errno 48] Address already in use`
- **Cause**: Backend already running on port 8000 with `uv`
- **Impact**: `npm run dev` backend startup fails

## ✅ Current Working Services

| Service | Status | Port | Access |
|---------|--------|------|--------|
| **Backend API** | ✅ Working | 8000 | `http://localhost:8000/docs` |
| **Agent Worker** | ✅ Working | - | Processing AI tasks |
| **Redis** | ✅ Working | 6379 | Message queue |
| **Frontend** | ✅ Working | 3000 | `http://localhost:3000` |
| **Supabase** | ❌ Not accessible | - | Network issue |

## 🔧 Immediate Solutions

### **Option 1: Run Frontend Only (Recommended)**
```bash
# Stop the conflicting npm run dev
# Run only frontend
cd frontend && npm run dev
```

### **Option 2: Use Local Development Mode**
```bash
# Update frontend/.env.local to work offline
NEXT_PUBLIC_ENV_MODE=LOCAL_OFFLINE
NEXT_PUBLIC_BACKEND_URL=http://localhost:8000/api
```

### **Option 3: Fix Supabase Connectivity**

#### Check Network Connection
```bash
# Test basic connectivity
curl -v https://supabase.co

# Test with different DNS
curl -v https://8.8.8.8
```

#### Try Alternative DNS
```bash
# Temporarily use Google DNS
sudo networksetup -setdnsservers Wi-Fi 8.8.8.8 8.8.4.4
```

#### Flush DNS Cache
```bash
sudo dscacheutil -flushcache
sudo killall -HUP mDNSResponder
```

## 🚀 Recommended Workflow

### **Current Working Setup:**
1. **✅ Backend**: `uv run api.py` (port 8000)
2. **✅ Agent Worker**: `uv run dramatiq run_agent_background`
3. **✅ Redis**: Docker (port 6379)
4. **✅ Frontend**: `cd frontend && npm run dev` (port 3000)

### **Start Services Individually:**
```bash
# Terminal 1: Redis
docker-compose up redis -d

# Terminal 2: Backend
cd backend && export PATH="$HOME/.local/bin:$PATH"
uv run api.py

# Terminal 3: Agent Worker  
cd backend && export PATH="$HOME/.local/bin:$PATH"
uv run dramatiq run_agent_background

# Terminal 4: Frontend
cd frontend && npm run dev
```

## 🔍 Network Diagnostics

### **Test Supabase Connectivity**
```bash
# Test DNS resolution
nslookup bzimzrdxrbdhvovahhtc.supabase.co

# Test HTTP connection
curl -I --connect-timeout 10 https://bzimzrdxrbdhvovahhtc.supabase.co

# Test with verbose output
curl -v https://bzimzrdxrbdhvovahhtc.supabase.co/rest/v1/
```

### **Network Configuration Check**
```bash
# Check current DNS servers
scutil --dns | grep nameserver

# Check network interface
ifconfig | grep inet

# Check firewall settings
sudo pfctl -s nat
```

## 🎯 Next Steps

### **Short Term (Get Working Now)**
1. **Keep current services running** (backend + frontend working)
2. **Skip Supabase authentication** temporarily
3. **Use local backend API** for development
4. **Test core functionality** without auth

### **Long Term (Fix Supabase)**
1. **Check Supabase project status** in dashboard
2. **Verify billing/payment** (paused projects lose connectivity)
3. **Consider network/VPN issues**
4. **Test from different network** if possible

## 🌟 Current Achievement

**✅ Core Kusor system is working!**
- Backend API fully functional
- Agent processing capabilities ready
- Frontend rendering correctly
- Only authentication/database connection needs fixing

The main functionality is operational - you can develop and test the core features while resolving the Supabase connectivity issue separately.
