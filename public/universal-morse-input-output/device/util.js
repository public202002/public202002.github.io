var validUrl = require('valid-url');
var http = require('http');
var cheerio = require('cheerio');

function fetchPage(url,cb){
  url = 'http://' + url;    //add URI prefix

  console.log('fetching page',url);
  var failed = false, failureTimeout;
  http.get(url,function(res){
    var pageContents = '';
    res.on('data',function(s){
      pageContents += s;
    });

    res.on('end',function(){
      clearTimeout(failureTimeout);
      if(failed) return;

      //console.log('returned response', pageContents);
      try {
        //pageContents = '<article><div class="body">Foo bar bat.</div><div class="body">Hello. World</div></article>';
        var text = extractTextContentFromPage(pageContents);
      } catch(e){
        return cb(e); 
      }
      cb(null, text);
    });
  }).on('error',function(err){
    console.log('error fetching web page',err);
    cb(err);
  });
}

function extractTextContentFromPage(pageContents){
  var $ = cheerio.load(pageContents);
  //assume some semantic markup
  return $('article .body').text().trim();
}

module.exports.fetchPage = fetchPage;
