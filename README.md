# Groww Trading Dashboard

A React-based dashboard for analyzing financial instruments, option chains, and AI-powered market insights using the Groww API.

## Features

✅ **Groww API Authentication** - Secure login with API key & secret  
✅ **Instrument Selection** - Browse and search all available symbols  
✅ **Real-time Quotes** - Live stock/instrument pricing  
✅ **Price Range Calculator** - Calculate ±% bounds from current price  
✅ **Option Chain Filtering** - Automatically filter options within calculated range  
✅ **AI Inference** - Get AI-powered analysis and recommendations  
✅ **Auto-Refresh** - Configurable dashboard refresh interval  
✅ **Multi-Exchange Support** - NSE, BSE, and MCX trading  
✅ **Responsive Design** - Works on desktop and mobile devices  

## Prerequisites

- Node.js 16+ and npm
- Python 3.8+
- Groww API credentials (API Key & Secret)
  - Get from: https://groww.in (Groww Cloud API Keys Page)
  - Requires daily approval

## Project Structure

```
instrument-dashboard/
├── src/                          # React frontend
│   ├── components/
│   │   ├── AuthForm.jsx          # API key & secret authentication
│   │   ├── InstrumentList.jsx    # Symbol browser & search
│   │   └── Dashboard.jsx         # Main dashboard
│   ├── services/
│   │   └── api.js                # API client
│   ├── App.jsx
│   └── main.jsx
├── server.py                     # Python Flask backend
├── requirements.txt              # Python dependencies
├── package.json                  # Node dependencies
└── README.md
```

## Installation

### 1. Frontend Setup

```bash
npm install
```

### 2. Backend Setup

```bash
pip install -r requirements.txt
```

### 3. Environment Configuration

Create a `.env` file in the root directory:

```
REACT_APP_API_BASE_URL=http://localhost:5000
PORT=5000
DEBUG=False
```

## Running the Application

### Terminal 1: Start Python Backend

```bash
python server.py
```

Backend runs on `http://localhost:5000`

### Terminal 2: Start React Frontend

```bash
npm run dev
```

Frontend runs on `http://localhost:3000`

## Usage

### 1. Authentication

1. Navigate to `http://localhost:3000`
2. Enter your Groww API Key
3. Enter your Groww API Secret
4. Click "Login"

Your credentials are validated and an access token is generated.

### 2. Select a Symbol

- Browse the symbol list on the left sidebar
- Search by symbol name or company name
- Click to select a symbol

### 3. View Current Quote

- Current price displays automatically
- Shows high, low, and volume data
- Click "🔄 Refresh" to update manually
- Auto-refresh runs at your configured interval

### 4. Calculate Price Range

1. Enter a percentage (e.g., 20 for ±20%)
2. Click "Calculate Range"
3. The app will:
   - Calculate lower and upper bounds
   - Fetch the option chain
   - Filter options within the range
   - Get AI inference on the data

### 5. Configure Auto-Refresh

- Set the refresh interval in milliseconds (default: 30,000ms = 30 seconds)
- Minimum: 5,000ms (5 seconds)
- Dashboard updates automatically at this interval

### 6. View Filtered Options

- See all options within your calculated price range
- Table shows strike price, type, bid/ask, volume, and IV

### 7. AI Insights

- Get AI-powered analysis of the filtered options
- Includes confidence scores and recommendations

## API Endpoints

### Authentication
- `POST /auth/token` - Get access token from API key & secret

### Market Data
- `GET /instruments` - List all available symbols
- `GET /quote` - Get current quote for a symbol
- `GET /option-chain` - Get option chain for a symbol
- `GET /historical` - Get historical price data

### Analysis
- `POST /ai/inference` - Get AI analysis on market data

## Groww API Integration

The backend uses the official Groww Python SDK:

```python
from growwapi import GrowwAPI

# Get access token
access_token = GrowwAPI.get_access_token(
    api_key="YOUR_API_KEY",
    secret="YOUR_API_SECRET"
)

# Initialize API
groww = GrowwAPI(access_token)

# Get quote
quote = groww.get_quote(symbol="INFY", exchange="NSE")

# Get option chain
options = groww.get_option_chain(symbol="INFY", exchange="NSE")
```

## Configuration

### Environment Variables

```
REACT_APP_API_BASE_URL=http://localhost:5000  # Backend URL
PORT=5000                                      # Backend port
DEBUG=False                                    # Flask debug mode
```

### Customization

- **Refresh Interval**: Adjust in Dashboard settings (5000ms minimum)
- **Percentage Range**: Change default in Dashboard component
- **Styling**: Modify CSS files in `src/components/`
- **AI Logic**: Update `/ai/inference` endpoint in `server.py`

## Supported Exchanges

- **NSE** (National Stock Exchange) - Equity, Derivatives, Commodities
- **BSE** (Bombay Stock Exchange) - Equity, Derivatives
- **MCX** (Multi Commodity Exchange) - Commodities

## Error Handling

- API errors are displayed in error banners
- Failed authentication shows clear error messages
- Network errors are handled gracefully
- Retry functionality available for most operations

## Browser Support

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+

## Performance

- Lazy loads symbols on demand
- Caches access token in localStorage
- Efficient re-rendering with React hooks
- Responsive grid layout
- Server-side request caching

## Security

- Access token stored in browser localStorage
- HTTPS recommended for production
- API credentials never logged
- CORS enabled for frontend-backend communication
- Bearer token authentication

## Troubleshooting

### "Failed to authenticate"
- Verify API Key and Secret are correct
- Check if credentials are approved on Groww Cloud
- Ensure backend server is running

### "Failed to load symbols"
- Check internet connection
- Verify backend is running on port 5000
- Check CORS settings

### "Failed to fetch current quote"
- Verify symbol exists on selected exchange
- Try a different symbol
- Check market hours

### Backend not starting
```bash
# Install missing dependencies
pip install -r requirements.txt

# Check Python version (3.8+)
python --version

# Run with debug mode
DEBUG=True python server.py
```

### Frontend not connecting to backend
- Ensure backend is running on `http://localhost:5000`
- Check `REACT_APP_API_BASE_URL` in `.env`
- Check browser console for CORS errors

## Production Deployment

### Frontend
```bash
npm run build
# Deploy dist/ folder to static hosting (Vercel, Netlify, etc.)
```

### Backend
```bash
# Use production WSGI server
pip install gunicorn
gunicorn -w 4 -b 0.0.0.0:5000 server:app
```

## Future Enhancements

- [ ] Historical price charts
- [ ] Advanced filtering options
- [ ] Portfolio tracking
- [ ] Real-time alerts
- [ ] Export data to CSV
- [ ] Dark mode
- [ ] Multi-symbol comparison
- [ ] Order placement integration
- [ ] WebSocket for real-time updates

## Support

For issues or questions:
1. Check the troubleshooting section
2. Review Groww API documentation: https://groww.in/docs
3. Check backend logs for errors
4. Verify API credentials are valid

## License

MIT

## Disclaimer

This dashboard is for educational and informational purposes only. Always verify data and consult with financial advisors before making trading decisions. The developers are not responsible for any financial losses.

