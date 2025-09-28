from fastmcp import FastMCP

mcp = FastMCP(name="Adentic")


@mcp.tool
async def get_weather(city: str) -> str:
    return f"The weather in {city} is windy."


@mcp.tool
async def get_wind_direction(city: str) -> str:
    return f"The wind direction in {city} is from the north."
