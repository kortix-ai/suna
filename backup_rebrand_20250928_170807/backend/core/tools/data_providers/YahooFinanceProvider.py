from typing import Dict

from core.tools.data_providers.RapidDataProviderBase import RapidDataProviderBase, EndpointSchema


class YahooFinanceProvider(RapidDataProviderBase):
    def __init__(self):
        endpoints: Dict[str, EndpointSchema] = {
            "get_tickers": {
                "route": "/v2/markets/tickers",
                "method": "GET",
                "name": "Yahoo Finance Tickers",
                "description": "Get financial tickers from Yahoo Finance with various filters and parameters.",
                "payload": {
                    "page": "Page number for pagination (optional, default: 1)",
                    "type": "Asset class type (required): STOCKS, ETF, MUTUALFUNDS, or FUTURES",
                }
            },
            "search": {
                "route": "/v1/markets/search",
                "method": "GET",
                "name": "Yahoo Finance Search",
                "description": "Search for financial instruments on Yahoo Finance",
                "payload": {
                    "search": "Search term (required)",
                }
            },
            "get_news": {
                "route": "/v2/markets/news",
                "method": "GET",
                "name": "Yahoo Finance News",
                "description": "Get news related to specific tickers from Yahoo Finance",
                "payload": {
                    "tickers": "Stock symbol (optional, e.g., AAPL)",
                    "type": "News type (optional): ALL, VIDEO, or PRESS_RELEASE",
                }
            },
            "get_stock_module": {
                "route": "/v1/markets/stock/modules",
                "method": "GET",
                "name": "Yahoo Finance Stock Module",
                "description": "Get detailed information about a specific stock module",
                "payload": {
                    "ticker": "Company ticker symbol (required, e.g., AAPL)",
                    "module": "Module to retrieve (required): asset-profile, financial-data, earnings, etc.",
                }
            },
            "get_sma": {
                "route": "/v1/markets/indicators/sma",
                "method": "GET",
                "name": "Yahoo Finance SMA Indicator",
                "description": "Get Simple Moving Average (SMA) indicator data for a stock",
                "payload": {
                    "symbol": "Stock symbol (required, e.g., AAPL)",
                    "interval": "Time interval (required): 5m, 15m, 30m, 1h, 1d, 1wk, 1mo, 3mo",
                    "series_type": "Series type (required): open, close, high, low",
                    "time_period": "Number of data points used for calculation (required)",
                    "limit": "Limit the number of results (optional, default: 50)",
                }
            },
            "get_rsi": {
                "route": "/v1/markets/indicators/rsi",
                "method": "GET",
                "name": "Yahoo Finance RSI Indicator",
                "description": "Get Relative Strength Index (RSI) indicator data for a stock",
                "payload": {
                    "symbol": "Stock symbol (required, e.g., AAPL)",
                    "interval": "Time interval (required): 5m, 15m, 30m, 1h, 1d, 1wk, 1mo, 3mo",
                    "series_type": "Series type (required): open, close, high, low",
                    "time_period": "Number of data points used for calculation (required)",
                    "limit": "Limit the number of results (optional, default: 50)",
                }
            },
            "get_earnings_calendar": {
                "route": "/v1/markets/calendar/earnings",
                "method": "GET",
                "name": "Yahoo Finance Earnings Calendar",
                "description": "Get earnings calendar data for a specific date",
                "payload": {
                    "date": "Calendar date in yyyy-mm-dd format (optional, e.g., 2023-11-30)",
                }
            },
            "get_insider_trades": {
                "route": "/v1/markets/insider-trades",
                "method": "GET",
                "name": "Yahoo Finance Insider Trades",
                "description": "Get recent insider trading activity",
                "payload": {}
            },
        }
        base_url = "https://yahoo-finance15.p.rapidapi.com/api"
        super().__init__(base_url, endpoints)


if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv()
    tool = YahooFinanceProvider()

    # Example for getting stock tickers
    tickers_result = tool.call_endpoint(
        route="get_tickers",
        payload={
            "page": 1,
            "type": "STOCKS"
        }
    )
    print("Tickers Result:", tickers_result)
    
    # Example for searching financial instruments
    search_result = tool.call_endpoint(
        route="search",
        payload={
            "search": "AA"
        }
    )
    print("Search Result:", search_result)
    
    # Example for getting financial news
    news_result = tool.call_endpoint(
        route="get_news",
        payload={
            "tickers": "AAPL",
            "type": "ALL"
        }
    )
    print("News Result:", news_result)
    
    # Example for getting stock asset profile module
    stock_module_result = tool.call_endpoint(
        route="get_stock_module",
        payload={
            "ticker": "AAPL",
            "module": "asset-profile"
        }
    )
    print("Asset Profile Result:", stock_module_result)
    
    # Example for getting financial data module
    financial_data_result = tool.call_endpoint(
        route="get_stock_module",
        payload={
            "ticker": "AAPL",
            "module": "financial-data"
        }
    )
    print("Financial Data Result:", financial_data_result)
    
    # Example for getting SMA indicator data
    sma_result = tool.call_endpoint(
        route="get_sma",
        payload={
            "symbol": "AAPL",
            "interval": "5m",
            "series_type": "close",
            "time_period": "50",
            "limit": "50"
        }
    )
    print("SMA Result:", sma_result)
    
    # Example for getting RSI indicator data
    rsi_result = tool.call_endpoint(
        route="get_rsi",
        payload={
            "symbol": "AAPL",
            "interval": "5m",
            "series_type": "close",
            "time_period": "50",
            "limit": "50"
        }
    )
    print("RSI Result:", rsi_result)
    
    # Example for getting earnings calendar data
    earnings_calendar_result = tool.call_endpoint(
        route="get_earnings_calendar",
        payload={
            "date": "2023-11-30"
        }
    )
    print("Earnings Calendar Result:", earnings_calendar_result)
    
    # Example for getting insider trades
    insider_trades_result = tool.call_endpoint(
        route="get_insider_trades",
        payload={}
    )
    print("Insider Trades Result:", insider_trades_result)

