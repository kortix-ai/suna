from typing import Dict

from core.tools.data_providers.RapidDataProviderBase import RapidDataProviderBase, EndpointSchema


class TwitterProvider(RapidDataProviderBase):
    def __init__(self):
        endpoints: Dict[str, EndpointSchema] = {
            "user_info": {
                "route": "/screenname.php",
                "method": "GET",
                "name": "Twitter User Info",
                "description": "Get information about a Twitter user by screenname or user ID.",
                "payload": {
                    "screenname": "Twitter username without the @ symbol",
                    "rest_id": "Optional Twitter user's ID. If provided, overwrites screenname parameter."
                }
            },
            "timeline": {
                "route": "/timeline.php",
                "method": "GET",
                "name": "User Timeline",
                "description": "Get tweets from a user's timeline.",
                "payload": {
                    "screenname": "Twitter username without the @ symbol",
                    "rest_id": "Optional parameter that overwrites the screenname",
                    "cursor": "Optional pagination cursor"
                }
            },
            "following": {
                "route": "/following.php",
                "method": "GET",
                "name": "User Following",
                "description": "Get users that a specific user follows.",
                "payload": {
                    "screenname": "Twitter username without the @ symbol",
                    "rest_id": "Optional parameter that overwrites the screenname",
                    "cursor": "Optional pagination cursor"
                }
            },
            "followers": {
                "route": "/followers.php",
                "method": "GET",
                "name": "User Followers",
                "description": "Get followers of a specific user.",
                "payload": {
                    "screenname": "Twitter username without the @ symbol",
                    "cursor": "Optional pagination cursor"
                }
            },
            "search": {
                "route": "/search.php",
                "method": "GET",
                "name": "Twitter Search",
                "description": "Search for tweets with a specific query.",
                "payload": {
                    "query": "Search query string",
                    "cursor": "Optional pagination cursor",
                    "search_type": "Optional search type (e.g. 'Top')"
                }
            },
            "replies": {
                "route": "/replies.php",
                "method": "GET",
                "name": "User Replies",
                "description": "Get replies made by a user.",
                "payload": {
                    "screenname": "Twitter username without the @ symbol",
                    "cursor": "Optional pagination cursor"
                }
            },
            "check_retweet": {
                "route": "/checkretweet.php",
                "method": "GET",
                "name": "Check Retweet",
                "description": "Check if a user has retweeted a specific tweet.",
                "payload": {
                    "screenname": "Twitter username without the @ symbol",
                    "tweet_id": "ID of the tweet to check"
                }
            },
            "tweet": {
                "route": "/tweet.php",
                "method": "GET",
                "name": "Get Tweet",
                "description": "Get details of a specific tweet by ID.",
                "payload": {
                    "id": "ID of the tweet"
                }
            },
            "tweet_thread": {
                "route": "/tweet_thread.php",
                "method": "GET",
                "name": "Get Tweet Thread",
                "description": "Get a thread of tweets starting from a specific tweet ID.",
                "payload": {
                    "id": "ID of the tweet",
                    "cursor": "Optional pagination cursor"
                }
            },
            "retweets": {
                "route": "/retweets.php",
                "method": "GET",
                "name": "Get Retweets",
                "description": "Get users who retweeted a specific tweet.",
                "payload": {
                    "id": "ID of the tweet",
                    "cursor": "Optional pagination cursor"
                }
            },
            "latest_replies": {
                "route": "/latest_replies.php",
                "method": "GET",
                "name": "Get Latest Replies",
                "description": "Get the latest replies to a specific tweet.",
                "payload": {
                    "id": "ID of the tweet",
                    "cursor": "Optional pagination cursor"
                }
            }
        }
        base_url = "https://twitter-api45.p.rapidapi.com"
        super().__init__(base_url, endpoints)


if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv()
    tool = TwitterProvider()

    # Example for getting user info
    user_info = tool.call_endpoint(
        route="user_info",
        payload={
            "screenname": "elonmusk",
            # "rest_id": "44196397"  # Optional, uncomment to use user ID instead of screenname
        }
    )
    print("User Info:", user_info)
    
    # Example for getting user timeline
    timeline = tool.call_endpoint(
        route="timeline",
        payload={
            "screenname": "elonmusk",
            # "cursor": "optional-cursor-value"  # Optional for pagination
        }
    )
    print("Timeline:", timeline)
    
    # Example for getting user following
    following = tool.call_endpoint(
        route="following",
        payload={
            "screenname": "elonmusk",
            # "cursor": "optional-cursor-value"  # Optional for pagination
        }
    )
    print("Following:", following)
    
    # Example for getting user followers
    followers = tool.call_endpoint(
        route="followers",
        payload={
            "screenname": "elonmusk",
            # "cursor": "optional-cursor-value"  # Optional for pagination
        }
    )
    print("Followers:", followers)
    
    # Example for searching tweets
    search_results = tool.call_endpoint(
        route="search",
        payload={
            "query": "cybertruck",
            "search_type": "Top"  # Optional, defaults to Top
            # "cursor": "optional-cursor-value"  # Optional for pagination
        }
    )
    print("Search Results:", search_results)
    
    # Example for getting user replies
    replies = tool.call_endpoint(
        route="replies",
        payload={
            "screenname": "elonmusk",
            # "cursor": "optional-cursor-value"  # Optional for pagination
        }
    )
    print("Replies:", replies)
    
    # Example for checking if user retweeted a tweet
    check_retweet = tool.call_endpoint(
        route="check_retweet",
        payload={
            "screenname": "elonmusk",
            "tweet_id": "1671370010743263233"
        }
    )
    print("Check Retweet:", check_retweet)
    
    # Example for getting tweet details
    tweet = tool.call_endpoint(
        route="tweet",
        payload={
            "id": "1671370010743263233"
        }
    )
    print("Tweet:", tweet)
    
    # Example for getting a tweet thread
    tweet_thread = tool.call_endpoint(
        route="tweet_thread",
        payload={
            "id": "1738106896777699464",
            # "cursor": "optional-cursor-value"  # Optional for pagination
        }
    )
    print("Tweet Thread:", tweet_thread)
    
    # Example for getting retweets of a tweet
    retweets = tool.call_endpoint(
        route="retweets",
        payload={
            "id": "1700199139470942473",
            # "cursor": "optional-cursor-value"  # Optional for pagination
        }
    )
    print("Retweets:", retweets)
    
    # Example for getting latest replies to a tweet
    latest_replies = tool.call_endpoint(
        route="latest_replies",
        payload={
            "id": "1738106896777699464",
            # "cursor": "optional-cursor-value"  # Optional for pagination
        }
    )
    print("Latest Replies:", latest_replies)
  