
// Message functions, see https://stackoverflow.com/a/32928812/2866660
var debug = console.log.bind(window.console);

// Parse query string from a URL into an object.
// after https://www.joezimjs.com/javascript/3-ways-to-parse-a-query-string-in-a-url/
var parseQueryString = function(url) {
  var params = {}, queryString, queries, temp, i, l;
  // Extract query string
  queryString = url.substring( url.indexOf('?') + 1 );
  // Split into key/value pairs
  queries = queryString.split('&');
  // Convert the array of strings into an object
  for ( i = 0, l = queries.length; i < l; i++ ) {
    temp = queries[i].split('=', 2);
    params[decodeURIComponent(temp[0])] = decodeURIComponent(temp[1]);
  }
  return params;
};
